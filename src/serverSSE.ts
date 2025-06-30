#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServiceInfo {
  commandCount: number;
  commands: string[];
  totalCommands: number;
  clientName?: string;
}

class DynamicAWSServer {
  private availableServices = new Map<string, any>();
  private clientCache = new Map<string, any>();
  private serviceInfo = new Map<string, ServiceInfo>();

  constructor() {
    this.discoverAWSServices();
  }

  // Log for HTTP server (use console.log instead of stderr)
  private log(message: string) {
    console.log(`[AWS-MCP] ${new Date().toISOString()} ${message}`);
  }

  // Dynamically discover all installed AWS SDK packages
  private async discoverAWSServices() {
    this.log('Discovering AWS services...');

    try {
      const possiblePaths = [
        path.join(process.cwd(), 'node_modules'),
        path.join(__dirname, '..', 'node_modules'),
        path.join(__dirname, '..', '..', 'node_modules'),
        path.join(__dirname, 'node_modules')
      ];

      let nodeModulesPath = '';
      for (const testPath of possiblePaths) {
        this.log(`Checking for node_modules at: ${testPath}`);
        if (fs.existsSync(testPath)) {
          nodeModulesPath = testPath;
          this.log(`Found node_modules at: ${nodeModulesPath}`);
          break;
        }
      }

      if (!nodeModulesPath) {
        this.log('node_modules not found in any expected location, loading fallback services');
        await this.loadFallbackServices();
        return;
      }

      const awsSdkPath = path.join(nodeModulesPath, '@aws-sdk');
      if (!fs.existsSync(awsSdkPath)) {
        this.log('No @aws-sdk directory found, loading fallback services');
        await this.loadFallbackServices();
        return;
      }

      const awsPackages = fs.readdirSync(awsSdkPath)
        .filter(pkg => pkg.startsWith('client-'))
        .map(pkg => pkg.replace('client-', ''));

      this.log(`Found ${awsPackages.length} AWS SDK packages: ${awsPackages.join(', ')}`);

      for (const serviceName of awsPackages) {
        try {
          this.log(`Attempting to load @aws-sdk/client-${serviceName}`);
          const serviceModule = await import(`@aws-sdk/client-${serviceName}`);
          this.availableServices.set(serviceName, serviceModule);
          this.analyzeService(serviceName, serviceModule);
          this.log(`Successfully loaded ${serviceName}`);
        } catch (error) {
          this.log(`Failed to load ${serviceName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (this.availableServices.size === 0) {
        this.log('No AWS services loaded from packages, using fallback');
        await this.loadFallbackServices();
      }

    } catch (error) {
      this.log(`Failed to discover AWS services: ${error instanceof Error ? error.message : String(error)}`);
      await this.loadFallbackServices();
    }

    this.log(`AWS MCP Server ready with ${this.availableServices.size} services`);
  }

  // Analyze service to extract commands and client info
  private analyzeService(serviceName: string, serviceModule: any) {
    const commands = Object.keys(serviceModule)
      .filter(key => key.endsWith('Command'))
      .sort();

    const clientName = Object.keys(serviceModule)
      .find(key => key.endsWith('Client'));

    this.serviceInfo.set(serviceName, {
      commandCount: commands.length,
      commands: commands,
      totalCommands: commands.length,
      clientName
    });
  }

  // Fallback list of common AWS services
  private async loadFallbackServices() {
    const commonServices = [
      's3', 'ec2', 'lambda', 'dynamodb', 'cloudwatch', 'iam', 'rds',
      'sns', 'sqs', 'cloudformation', 'ecs', 'eks', 'route53', 'cloudfront',
      'apigateway', 'apigatewayv2', 'cognito-identity', 'cognito-identity-provider',
      'secrets-manager', 'ssm', 'sts', 'organizations', 'cost-explorer',
      'config-service', 'cloudtrail', 'cloudwatch-logs', 'auto-scaling', 'elasticache'
    ];

    this.log('Loading fallback services...');

    for (const service of commonServices) {
      try {
        this.log(`Attempting to load @aws-sdk/client-${service}`);
        const serviceModule = await import(`@aws-sdk/client-${service}`);
        this.availableServices.set(service, serviceModule);
        this.analyzeService(service, serviceModule);
        this.log(`Successfully loaded ${service} (fallback)`);
      } catch (error) {
        this.log(`Skipped ${service} (not installed): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Get all commands for a service
  private getServiceCommands(serviceName: string): string[] {
    const info = this.serviceInfo.get(serviceName);
    return info ? info.commands : [];
  }

  // Get client for service
  private async getClient(serviceName: string, region = 'us-east-1') {
    const cacheKey = `${serviceName}-${region}`;

    if (!this.clientCache.has(cacheKey)) {
      const serviceModule = this.availableServices.get(serviceName);
      if (!serviceModule) {
        throw new Error(`Service ${serviceName} not available. Install with: npm install @aws-sdk/client-${serviceName}`);
      }

      const info = this.serviceInfo.get(serviceName);
      const clientName = info?.clientName;

      if (!clientName) {
        throw new Error(`No client found for service ${serviceName}`);
      }

      const ClientClass = serviceModule[clientName];
      const client = new ClientClass({
        region,
        // Use ncfx-dev profile
        credentials: process.env.AWS_PROFILE ? undefined : (await import('@aws-sdk/credential-providers')).fromIni({
          profile: 'ncfx-dev'
        }),
        // Add default retry configuration
        maxAttempts: 3
      });

      this.clientCache.set(cacheKey, client);
      this.log(`Created client for ${serviceName} in ${region}`);
    }

    return this.clientCache.get(cacheKey);
  }

  // Execute any AWS command
  async executeCommand(serviceName: string, commandName: string, parameters: any = {}, region?: string) {
    this.log(`Executing ${serviceName}.${commandName}`);

    const serviceModule = this.availableServices.get(serviceName);
    if (!serviceModule) {
      throw new Error(`Service ${serviceName} not available. Install with: npm install @aws-sdk/client-${serviceName}`);
    }

    // Ensure command name ends with 'Command'
    const fullCommandName = commandName.endsWith('Command') ? commandName : `${commandName}Command`;
    const CommandClass = serviceModule[fullCommandName];

    if (!CommandClass) {
      const availableCommands = this.getServiceCommands(serviceName);
      throw new Error(
        `Command ${fullCommandName} not found in service ${serviceName}. ` +
        `Available commands: ${availableCommands.slice(0, 5).join(', ')}${availableCommands.length > 5 ? '...' : ''}`
      );
    }

    const client = await this.getClient(serviceName, region);
    const command = new CommandClass(parameters);

    const startTime = Date.now();
    try {
      const result = await client.send(command);
      const duration = Date.now() - startTime;
      this.log(`${serviceName}.${commandName} completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`${serviceName}.${commandName} failed after ${duration}ms: ${errorMessage}`);
      throw error;
    }
  }

  // Generate tools dynamically
  generateTools() {
    const availableServiceNames = Array.from(this.availableServices.keys()).sort();

    const tools = [
      {
        name: 'aws_execute',
        description: 'Execute any AWS API command. Use this for all AWS operations.',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: 'AWS service name (e.g., s3, ec2, lambda)',
              enum: availableServiceNames
            },
            command: {
              type: 'string',
              description: 'Command name (with or without "Command" suffix, e.g., "ListBuckets" or "ListBucketsCommand")'
            },
            parameters: {
              type: 'object',
              description: 'Command parameters as key-value pairs',
              default: {},
              additionalProperties: true
            },
            region: {
              type: 'string',
              description: 'AWS region (e.g., us-east-1, eu-west-1)',
              default: 'us-east-1'
            }
          },
          required: ['service', 'command'],
          additionalProperties: false
        }
      },
      {
        name: 'aws_list_services',
        description: 'List all available AWS services with their command counts',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'aws_list_commands',
        description: 'List all available commands for a specific AWS service',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: 'AWS service name',
              enum: availableServiceNames
            },
            limit: {
              type: 'number',
              description: 'Maximum number of commands to return (default: all)',
              minimum: 1,
              maximum: 100
            }
          },
          required: ['service'],
          additionalProperties: false
        }
      },
      {
        name: 'aws_service_info',
        description: 'Get detailed information about a specific AWS service',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: 'AWS service name',
              enum: availableServiceNames
            }
          },
          required: ['service'],
          additionalProperties: false
        }
      },
      {
        name: 'aws_command_parameters',
        description: 'Get parameters for a specific AWS command',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: 'AWS service name',
              enum: availableServiceNames
            },
            command: {
              type: 'string',
              description: 'Command name (with or without "Command" suffix, e.g., "ListBuckets" or "ListBucketsCommand")'
            }
          },
          required: ['service', 'command'],
          additionalProperties: false
        }
      }
    ];

    return tools;
  }

  // Get comprehensive service information
  getServicesOverview(): Record<string, any> {
    const services: Record<string, any> = {};
    for (const [serviceName, info] of this.serviceInfo) {
      services[serviceName] = {
        commandCount: info.commandCount,
        clientName: info.clientName,
        sampleCommands: info.commands.slice(0, 5)
      };
    }
    return services;
  }

  // Get detailed service information
  getServiceDetails(serviceName: string) {
    const info = this.serviceInfo.get(serviceName);
    if (!info) {
      throw new Error(`Service ${serviceName} not found`);
    }

    return {
      serviceName,
      totalCommands: info.totalCommands,
      clientName: info.clientName,
      allCommands: info.commands
    };
  }

  // Get available parameters for a command
  getCommandParameters(serviceName: string, commandName: string) {
    const serviceModule = this.availableServices.get(serviceName);
    if (!serviceModule) {
      throw new Error(`Service ${serviceName} not available. Install with: npm install @aws-sdk/client-${serviceName}`);
    }

    // Ensure command name ends with 'Command'
    const fullCommandName = commandName.endsWith('Command') ? commandName : `${commandName}Command`;
    const CommandClass = serviceModule[fullCommandName];

    if (!CommandClass) {
      throw new Error(`Command ${fullCommandName} not found in service ${serviceName}`);
    }
    // Try to get the parameters from a json file located in aws-schemas/{lowercase service name}/{command name}.json
    const serviceDir = path.join(__dirname, '../aws-schemas', serviceName.toLowerCase());
    const commandFile = path.join(serviceDir, `${fullCommandName.toLowerCase()}.json`);
    console.log(`Looking for command parameters in: ${commandFile}`);
    console.log(`Service directory: ${serviceDir}`);
    if (fs.existsSync(commandFile)) {
      try {
        const parameters = JSON.parse(fs.readFileSync(commandFile, 'utf-8'));
        return parameters;
      } catch (error) {
        throw new Error(`Failed to read parameters for ${serviceName}.${commandName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new Error(`No parameters file found for ${serviceName}.${commandName}. Please provide a JSON schema in aws-schemas/${serviceName.toLowerCase()}/${commandName.toLowerCase()}.json`);
    }
    

  }
}

// Initialize the dynamic AWS server
const awsServer = new DynamicAWSServer();

// Wait for AWS services to be discovered
await new Promise(resolve => setTimeout(resolve, 2000));

// Create MCP Server
function createMCPServer() {
  const server = new Server(
    {
      name: 'dynamic-aws-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Handle tools list request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: awsServer.generateTools()
    };
  });

  // Handle tools call request
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'aws_execute': {
          const { service, command, parameters = {}, region } = args as {
            service: string;
            command: string;
            parameters?: any;
            region?: string;
          };

          if (!service || !command) {
            throw new Error('Both service and command are required');
          }

          const result = await awsServer.executeCommand(service, command, parameters, region);

          return {
            content: [{
              type: 'text',
              text: `AWS ${service}.${command} executed successfully:\n\n${JSON.stringify(result, null, 2)}`
            }]
          };
        }

        case 'aws_list_services': {
          const services = awsServer.getServicesOverview();
          const serviceCount = Object.keys(services).length;

          const servicesList = Object.entries(services)
            .map(([name, info]: [string, any]) =>
              `• ${name}: ${info.commandCount} commands (${info.sampleCommands.slice(0, 3).join(', ')}${info.commandCount > 3 ? '...' : ''})`
            )
            .join('\n');

          return {
            content: [{
              type: 'text',
              text: `Available AWS Services (${serviceCount} total):\n\n${servicesList}\n\nUse aws_list_commands to see all commands for a specific service.`
            }]
          };
        }

        case 'aws_list_commands': {
          const { service, limit } = args as {
            service: string;
            limit?: number;
          };
          const details = awsServer.getServiceDetails(service);
          const commands = limit ? details.allCommands.slice(0, limit) : details.allCommands;

          const commandsList = commands.map(cmd => `• ${cmd}`).join('\n');
          const truncatedNote = limit && details.allCommands.length > limit
            ? `\n\n(Showing ${limit} of ${details.totalCommands} commands. Remove limit to see all.)`
            : '';

          return {
            content: [{
              type: 'text',
              text: `Commands for AWS ${service} (${details.totalCommands} total):\n\n${commandsList}${truncatedNote}`
            }]
          };
        }

        case 'aws_service_info': {
          const { service } = args as {
            service: string;
          };
          const details = awsServer.getServiceDetails(service);

          return {
            content: [{
              type: 'text',
              text: `AWS ${service} Service Information:\n\n` +
                `• Client: ${details.clientName}\n` +
                `• Total Commands: ${details.totalCommands}\n` +
                `• Common Commands: ${details.allCommands.slice(0, 10).join(', ')}\n\n` +
                `Use aws_list_commands to see all available commands.`
            }]
          };
        }

        case 'aws_command_parameters': {
          const { service, command } = args as {
            service: string;
            command: string;
          };

          const serviceModule = awsServer.getCommandParameters(service, command);
          return {
            content: [{
              type: 'text',
              text: `Parameters for ${service}.${command}:\n\n` +
                `${JSON.stringify(serviceModule, null, 2)}`
            }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [{
          type: 'text',
          text: `Error executing ${name}: ${errorMessage}`
        }],
        isError: true
      };
    }
  });

  return server;
}

// Create Express app for HTTP server
const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all origins (required for remote MCP)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(express.json());

// Add comprehensive request logging middleware
app.use((req, res, next) => {
  console.log(`[AWS-MCP] ${req.method} ${req.path}`);
  console.log(`[AWS-MCP] Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`[AWS-MCP] Query:`, JSON.stringify(req.query, null, 2));
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`[AWS-MCP] Body:`, JSON.stringify(req.body, null, 2));
  }
  next();
});

// MCP Server Discovery endpoint
app.get('/.well-known/mcp', (req, res) => {
  res.json({
    name: 'dynamic-aws-server',
    version: '1.0.0',
    description: 'Dynamic AWS MCP Server with comprehensive service support',
    sse_endpoint: '/sse',
    auth_required: false,
    capabilities: {
      tools: true
    }
  });
});

// MCP Manifest endpoint
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'dynamic-aws-server',
    version: '1.0.0',
    description: 'Dynamic AWS MCP Server',
    endpoints: {
      sse: '/sse'
    },
    auth: {
      type: 'none'
    }
  });
});

// Authentication endpoint for Claude (enhanced)
app.post('/auth', express.json(), (req, res) => {
  console.log(`[AWS-MCP] Auth request:`, req.body);

  res.json({
    success: true,
    access_token: 'mcp-token-' + Date.now(),
    token_type: 'Bearer',
    expires_in: 86400, // 24 hours
    sse_endpoint: '/sse'
  });
});

// Handle OAuth-style auth flow
app.get('/auth', (req, res) => {
  console.log(`[AWS-MCP] Auth GET request:`, req.query);

  const redirectUrl = req.query.redirect_uri || req.query.redirect_url;
  if (redirectUrl) {
    const token = 'mcp-token-' + Date.now();
    const authCode = 'auth-code-' + Date.now();
    res.redirect(`${redirectUrl}?code=${authCode}&state=${req.query.state || ''}`);
  } else {
    res.json({
      success: true,
      message: 'Authentication successful',
      sse_endpoint: '/sse'
    });
  }
});

// Token exchange endpoint
app.post('/token', express.json(), (req, res) => {
  console.log(`[AWS-MCP] Token exchange request:`, req.body);

  res.json({
    access_token: 'mcp-token-' + Date.now(),
    token_type: 'Bearer',
    expires_in: 86400,
    refresh_token: 'refresh-token-' + Date.now(),
    sse_endpoint: '/sse'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    services: awsServer.getServicesOverview(),
    timestamp: new Date().toISOString(),
    hasActiveConnection: globalTransport !== null
  });
});

// Global transport and server instances
let globalTransport: any = null;
let globalServer: any = null;

// SSE endpoint for MCP protocol (GET - establish connection)
app.get('/sse', async (req, res) => {
  console.log(`[AWS-MCP] New SSE connection from ${req.ip}`);
  console.log(`[AWS-MCP] Headers:`, req.headers);
  console.log(`[AWS-MCP] Query:`, req.query);

  try {
    // Create SSE transport - this handles the SSE connection
    const transport = new SSEServerTransport('/sse', res);
    const server = createMCPServer();

    // Store globally for POST requests
    globalTransport = transport;
    globalServer = server;

    // Handle connection close
    req.on('close', () => {
      console.log(`[AWS-MCP] SSE connection closed from ${req.ip}`);
      globalTransport = null;
      globalServer = null;
    });

    req.on('error', (error) => {
      console.error(`[AWS-MCP] SSE connection error:`, error);
      globalTransport = null;
      globalServer = null;
    });

    // Connect the MCP server to the SSE transport
    await server.connect(transport);
    console.log(`[AWS-MCP] MCP server connected via SSE for ${req.ip}`);

  } catch (error) {
    console.error('[AWS-MCP] SSE setup error:', error);
    globalTransport = null;
    globalServer = null;
    if (!res.headersSent) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: 'Failed to establish SSE connection', details: errorMessage });
    }
  }
});

// SSE endpoint for MCP protocol (POST - send messages)
app.post('/sse', async (req, res) => {
  console.log(`[AWS-MCP] POST message to SSE from ${req.ip}`);
  console.log(`[AWS-MCP] Headers:`, req.headers);
  console.log(`[AWS-MCP] Body:`, req.body);

  try {
    const message = req.body;

    // Validate JSON-RPC structure
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request'
        },
        id: message?.id || null
      });
    }    // Handle different types of messages
    if (message.method === 'initialize') {
      // Extract the client's protocol version from the request
      const clientProtocolVersion = message.params?.protocolVersion || '2024-11-05';
      console.log(`[AWS-MCP] Client requesting protocol version: ${clientProtocolVersion}`);

      // Support both protocol versions
      let serverProtocolVersion = clientProtocolVersion;
      if (clientProtocolVersion === '2025-03-26') {
        serverProtocolVersion = '2025-03-26';
      } else {
        serverProtocolVersion = '2024-11-05';
      }

      console.log(`[AWS-MCP] Responding with protocol version: ${serverProtocolVersion}`);

      const response = {
        jsonrpc: '2.0',
        result: {
          protocolVersion: serverProtocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'dynamic-aws-server',
            version: '1.0.0'
          }
        },
        id: message.id
      };
      return res.json(response);
    }

    if (message.method === 'tools/list') {
      const tools = awsServer.generateTools();
      const response = {
        jsonrpc: '2.0',
        result: {
          tools: tools
        },
        id: message.id
      };
      return res.json(response);
    }

    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;

      try {
        let result;

        switch (name) {
          case 'aws_execute': {
            const { service, command, parameters = {}, region } = args;
            if (!service || !command) {
              throw new Error('Both service and command are required');
            }
            const executeResult = await awsServer.executeCommand(service, command, parameters, region);
            result = {
              content: [{
                type: 'text',
                text: `AWS ${service}.${command} executed successfully:\n\n${JSON.stringify(executeResult, null, 2)}`
              }]
            };
            break;
          }

          case 'aws_list_services': {
            const services = awsServer.getServicesOverview();
            const serviceCount = Object.keys(services).length;
            const servicesList = Object.entries(services)
              .map(([name, info]: [string, any]) =>
                `• ${name}: ${info.commandCount} commands (${info.sampleCommands.slice(0, 3).join(', ')}${info.commandCount > 3 ? '...' : ''})`
              )
              .join('\n');
            result = {
              content: [{
                type: 'text',
                text: `Available AWS Services (${serviceCount} total):\n\n${servicesList}\n\nUse aws_list_commands to see all commands for a specific service.`
              }]
            };
            break;
          }

          case 'aws_list_commands': {
            const { service, limit } = args;
            const details = awsServer.getServiceDetails(service);
            const commands = limit ? details.allCommands.slice(0, limit) : details.allCommands;
            const commandsList = commands.map(cmd => `• ${cmd}`).join('\n');
            const truncatedNote = limit && details.allCommands.length > limit
              ? `\n\n(Showing ${limit} of ${details.totalCommands} commands. Remove limit to see all.)`
              : '';
            result = {
              content: [{
                type: 'text',
                text: `Commands for AWS ${service} (${details.totalCommands} total):\n\n${commandsList}${truncatedNote}`
              }]
            };
            break;
          }

          case 'aws_service_info': {
            const { service } = args;
            const details = awsServer.getServiceDetails(service);
            result = {
              content: [{
                type: 'text',
                text: `AWS ${service} Service Information:\n\n` +
                  `• Client: ${details.clientName}\n` +
                  `• Total Commands: ${details.totalCommands}\n` +
                  `• Common Commands: ${details.allCommands.slice(0, 10).join(', ')}\n\n` +
                  `Use aws_list_commands to see all available commands.`
              }]
            };
            break;
          }

          case 'aws_command_parameters': {
            const { service, command } = args;
            const serviceModule = awsServer.getCommandParameters(service, command);
            result = {
              content: [{
                type: 'text',
                text: `Parameters for ${service}.${command}:\n\n` +
                  `${JSON.stringify(serviceModule, null, 2)}`
              }]
            };
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        const response = {
          jsonrpc: '2.0',
          result: result,
          id: message.id
        };
        return res.json(response);

      } catch (toolError) {
        const errorMessage = toolError instanceof Error ? toolError.message : String(toolError);
        const response = {
          jsonrpc: '2.0',
          result: {
            content: [{
              type: 'text',
              text: `Error executing ${name}: ${errorMessage}`
            }],
            isError: true
          },
          id: message.id
        };
        return res.json(response);
      }
    }

    // Unknown method
    const response = {
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: 'Method not found'
      },
      id: message.id
    };
    return res.json(response);

  } catch (error) {
    console.error('[AWS-MCP] Error handling POST message:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    const response = {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal error',
        data: errorMessage
      },
      id: req.body?.id || null
    };
    return res.status(500).json(response);
  }
});

// Start HTTP server
app.listen(port, () => {
  console.log(`[AWS-MCP] HTTP server running on port ${port}`);
  console.log(`[AWS-MCP] SSE endpoint: http://localhost:${port}/sse`);
  console.log(`[AWS-MCP] Health check: http://localhost:${port}/health`);
  console.log(`[AWS-MCP] Ready for remote MCP connections`);
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('[AWS-MCP] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[AWS-MCP] Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', async () => {
  console.log('[AWS-MCP] Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[AWS-MCP] Shutting down...');
  process.exit(0);
});