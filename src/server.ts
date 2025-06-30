#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

  // Log to stderr to avoid interfering with MCP protocol
  private log(message: string) {
    console.error(`[AWS-MCP] ${message}`);
  }

  // Dynamically discover all installed AWS SDK packages
  private async discoverAWSServices() {
    this.log('Discovering AWS services...');
    
    try {
      // Try multiple approaches to find node_modules
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

      // Check if @aws-sdk directory exists
      const awsSdkPath = path.join(nodeModulesPath, '@aws-sdk');
      if (!fs.existsSync(awsSdkPath)) {
        this.log('No @aws-sdk directory found, loading fallback services');
        await this.loadFallbackServices();
        return;
      }

      // Find AWS SDK packages
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
}

// Initialize the dynamic AWS server
const awsServer = new DynamicAWSServer();

// Wait for AWS services to be discovered
await new Promise(resolve => setTimeout(resolve, 2000));

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

// Error handling
server.onerror = (error) => {
  console.error('[AWS-MCP] Server error:', error);
};

process.on('SIGINT', async () => {
  console.error('[AWS-MCP] Shutting down...');
  await server.close();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[AWS-MCP] Server is running and ready for connections');
}

main().catch((error) => {
  console.error('[AWS-MCP] Failed to start server:', error);
  process.exit(1);
});