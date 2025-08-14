/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { LLMDelegate, LLMConversation, LLMToolCall, LLMTool } from './loop.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const model = 'claude-sonnet-4-20250514';

export class ClaudeDelegate implements LLMDelegate {
  private _anthropic: Anthropic | undefined;

  async anthropic(): Promise<Anthropic> {
    if (!this._anthropic) {
      const anthropic = await import('@anthropic-ai/sdk');
      this._anthropic = new anthropic.Anthropic();
    }
    return this._anthropic;
  }

  createConversation(task: string, tools: Tool[], oneShot: boolean): LLMConversation {
    const llmTools: LLMTool[] = tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema,
    }));

    if (!oneShot) {
      llmTools.push({
        name: 'done',
        description: 'Call this tool when the task is complete.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      });
    }

    return {
      messages: [{
        role: 'user',
        content: task
      }],
      tools: llmTools,
    };
  }

  async makeApiCall(conversation: LLMConversation): Promise<LLMToolCall[]> {
    // Convert generic messages to Claude format
    const claudeMessages: Anthropic.Messages.MessageParam[] = [];
    let pendingToolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const message of conversation.messages) {
      if (message.role === 'user') {
        claudeMessages.push({
          role: 'user',
          content: message.content
        });
      } else if (message.role === 'assistant') {
        const content: Anthropic.Messages.ContentBlock[] = [];

        // Add text content
        if (message.content) {
          content.push({
            type: 'text',
            text: message.content,
            citations: []
          });
        }

        // Add tool calls
        if (message.toolCalls) {
          for (const toolCall of message.toolCalls) {
            content.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.arguments
            });
          }
        }

        claudeMessages.push({
          role: 'assistant',
          content
        });
        
        // Reset pending tool results after assistant message with tool calls
        if (message.toolCalls && message.toolCalls.length > 0) {
          pendingToolResults = [];
        }
      } else if (message.role === 'tool') {
        // Collect tool results
        const toolResult: Anthropic.Messages.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError,
        };
        
        pendingToolResults.push(toolResult);
        
        // Check if we need to flush tool results
        // We flush when we've collected all results for the previous assistant's tool calls
        const lastAssistantMessage = [...conversation.messages].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMessage && lastAssistantMessage.toolCalls) {
          const allToolCallIds = lastAssistantMessage.toolCalls.map(tc => tc.id);
          const collectedIds = pendingToolResults.map(tr => tr.tool_use_id);
          
          // If we have all the tool results for the last assistant message, add them
          if (allToolCallIds.every(id => collectedIds.includes(id))) {
            claudeMessages.push({
              role: 'user',
              content: [...pendingToolResults]
            });
            pendingToolResults = [];
          }
        }
      }
    }
    
    // Flush any remaining tool results
    if (pendingToolResults.length > 0) {
      claudeMessages.push({
        role: 'user',
        content: pendingToolResults
      });
    }

    // Convert generic tools to Claude format
    const claudeTools: Anthropic.Messages.Tool[] = conversation.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    const anthropic = await this.anthropic();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 10000,
      messages: claudeMessages,
      tools: claudeTools,
    });

    // Extract tool calls and add assistant message to generic conversation
    const toolCalls = response.content.filter(block => block.type === 'tool_use') as Anthropic.Messages.ToolUseBlock[];
    const textContent = response.content.filter(block => block.type === 'text').map(block => (block as Anthropic.Messages.TextBlock).text).join('');

    const llmToolCalls: LLMToolCall[] = toolCalls.map(toolCall => ({
      name: toolCall.name,
      arguments: toolCall.input as any,
      id: toolCall.id,
    }));

    // Add assistant message to generic conversation
    conversation.messages.push({
      role: 'assistant',
      content: textContent,
      toolCalls: llmToolCalls.length > 0 ? llmToolCalls : undefined
    });

    return llmToolCalls;
  }

  addToolResults(
    conversation: LLMConversation,
    results: Array<{ toolCallId: string; content: string; isError?: boolean }>
  ): void {
    for (const result of results) {
      conversation.messages.push({
        role: 'tool',
        toolCallId: result.toolCallId,
        content: result.content,
        isError: result.isError,
      });
    }
  }

  checkDoneToolCall(toolCall: LLMToolCall): string | null {
    if (toolCall.name === 'done')
      return (toolCall.arguments as { result: string }).result;

    return null;
  }
}
