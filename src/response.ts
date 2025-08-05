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

import { renderModalStates } from './tab.js';

import type { Tab, TabSnapshot } from './tab.js';
import type { ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from './context.js';

export class Response {
  private _result: string[] = [];
  private _code: string[] = [];
  private _images: { contentType: string, data: Buffer }[] = [];
  private _context: Context;
  private _includeSnapshot = false;
  private _includeTabs = false;
  private _tabSnapshot: TabSnapshot | undefined;
  private static readonly TOKEN_LIMIT = 22000; // Set lower than Claude Code's 25k limit to ensure our truncation triggers first
  private _paginationInfo: { needsPagination: boolean, totalPages?: number, currentPage?: number } | undefined;

  readonly toolName: string;
  readonly toolArgs: Record<string, any>;
  private _isError: boolean | undefined;

  constructor(context: Context, toolName: string, toolArgs: Record<string, any>) {
    this._context = context;
    this.toolName = toolName;
    this.toolArgs = toolArgs;
  }

  addResult(result: string) {
    this._result.push(result);
  }

  addError(error: string) {
    this._result.push(error);
    this._isError = true;
  }

  isError() {
    return this._isError;
  }

  result() {
    return this._result.join('\n');
  }

  addCode(code: string) {
    this._code.push(code);
  }

  code() {
    return this._code.join('\n');
  }

  addImage(image: { contentType: string, data: Buffer }) {
    this._images.push(image);
  }

  images() {
    return this._images;
  }

  setIncludeSnapshot() {
    this._includeSnapshot = true;
  }

  setIncludeTabs() {
    this._includeTabs = true;
  }

  /**
   * Check if content exceeds token limit and needs pagination
   */
  checkTokenLimit(content: string): { needsPagination: boolean, totalPages?: number, message?: string } {
    // Rough token estimation: 1 token ≈ 4 characters for English text
    const estimatedTokens = Math.ceil(content.length / 4);
    
    if (estimatedTokens > Response.TOKEN_LIMIT) {
      const totalPages = Math.ceil(estimatedTokens / Response.TOKEN_LIMIT);
      return {
        needsPagination: true,
        totalPages,
        message: `⚠️ 返回内容过大 (约${estimatedTokens.toLocaleString()} tokens)，超出限制 (${Response.TOKEN_LIMIT.toLocaleString()} tokens)。需要分${totalPages}页获取。`
      };
    }
    
    return { needsPagination: false };
  }

  /**
   * Set pagination information for the response
   */
  setPaginationInfo(needsPagination: boolean, totalPages?: number, currentPage?: number) {
    this._paginationInfo = { needsPagination, totalPages, currentPage };
  }

  /**
   * Add pagination warning to response
   */
  addPaginationWarning(totalPages: number, toolName: string, additionalParams: Record<string, any> = {}) {
    const baseParams = { ...this.toolArgs, ...additionalParams };
    delete baseParams.limit;
    delete baseParams.offset;

    let message = `⚠️ 返回内容过大，建议分${totalPages}页获取：\n\n`;
    
    for (let page = 1; page <= Math.min(totalPages, 5); page++) {
      const offset = (page - 1) * (baseParams.limit || 100);
      const pageParams = { 
        ...baseParams, 
        limit: baseParams.limit || 100, 
        offset 
      };
      message += `页面${page}/${totalPages}: 使用参数 ${JSON.stringify(pageParams)}\n`;
    }
    
    if (totalPages > 5) {
      message += `... (还有${totalPages - 5}页)\n`;
    }
    
    message += `\n或考虑使用更小的limit值来减少每页数据量。`;
    
    this.addResult(message);
  }

  /**
   * Create a truncated snapshot when the full snapshot exceeds token limits
   */
  private _createTruncatedSnapshot(fullSnapshot: TabSnapshot, tokenCheck: { needsPagination: boolean, totalPages?: number, message?: string }): TabSnapshot {
    const estimatedTokens = Math.ceil(fullSnapshot.ariaSnapshot.length / 4);
    
    // Calculate target length to fit within token limit
    const targetLength = Response.TOKEN_LIMIT * 4; // Convert tokens back to characters
    const truncationPoint = Math.floor(targetLength * 0.8); // Use 80% to leave room for warning message
    
    // Truncate the ARIA snapshot
    const truncatedAriaSnapshot = fullSnapshot.ariaSnapshot.substring(0, truncationPoint);
    
    // Add truncation warning to the snapshot
    const warningMessage = `

⚠️ SNAPSHOT TRUNCATED: Page snapshot was too large (${estimatedTokens.toLocaleString()} tokens, limit: ${Response.TOKEN_LIMIT.toLocaleString()}).

To get a complete snapshot, use browser_snapshot with filtering parameters:
- {"maxElements": 200} - Limit number of elements
- {"elementTypes": ["button", "textbox", "link", "heading"]} - Filter by element types  
- {"skipLargeTexts": true} - Skip elements with large text content
- Combine parameters for best results

--- TRUNCATED SNAPSHOT ABOVE ---`;

    return {
      ...fullSnapshot,
      ariaSnapshot: truncatedAriaSnapshot + warningMessage
    };
  }

  async finish() {
    // All the async snapshotting post-action is happening here.
    // Everything below should race against modal states.
    if (this._includeSnapshot && this._context.currentTab()) {
      const tempSnapshot = await this._context.currentTabOrDie().captureSnapshot();
      
      // Apply token limiting to automatic snapshots
      if (tempSnapshot?.ariaSnapshot) {
        const tokenCheck = this.checkTokenLimit(tempSnapshot.ariaSnapshot);
        
        if (tokenCheck.needsPagination) {
          // Create a truncated snapshot with guidance
          const truncatedSnapshot = this._createTruncatedSnapshot(tempSnapshot, tokenCheck);
          this._tabSnapshot = truncatedSnapshot;
        } else {
          this._tabSnapshot = tempSnapshot;
        }
      } else {
        this._tabSnapshot = tempSnapshot;
      }
    }
    for (const tab of this._context.tabs())
      await tab.updateTitle();
  }

  tabSnapshot(): TabSnapshot | undefined {
    return this._tabSnapshot;
  }

  serialize(): { content: (TextContent | ImageContent)[], isError?: boolean } {
    const response: string[] = [];

    // Start with command result.
    if (this._result.length) {
      response.push('### Result');
      response.push(this._result.join('\n'));
      response.push('');
    }

    // Add code if it exists.
    if (this._code.length) {
      response.push(`### Ran Playwright code
\`\`\`js
${this._code.join('\n')}
\`\`\``);
      response.push('');
    }

    // List browser tabs.
    if (this._includeSnapshot || this._includeTabs)
      response.push(...renderTabsMarkdown(this._context.tabs(), this._includeTabs));

    // Add snapshot if provided.
    if (this._tabSnapshot?.modalStates.length) {
      response.push(...renderModalStates(this._context, this._tabSnapshot.modalStates));
      response.push('');
    } else if (this._tabSnapshot) {
      response.push(renderTabSnapshot(this._tabSnapshot));
      response.push('');
    }

    // Final token limiting check before returning response
    const fullResponse = response.join('\n');
    const tokenCheck = this.checkTokenLimit(fullResponse);
    
    // Add debug logging
    console.error(`[DEBUG] Response length: ${fullResponse.length} characters, estimated tokens: ${Math.ceil(fullResponse.length / 4)}, needs pagination: ${tokenCheck.needsPagination}`);
    
    if (tokenCheck.needsPagination) {
      // If response is still too large, apply emergency truncation
      const maxLength = Response.TOKEN_LIMIT * 4 * 0.9; // Use 90% of limit for safety
      const truncated = fullResponse.substring(0, maxLength);
      const warningMsg = `\n\n⚠️ RESPONSE TRUNCATED: Output exceeded ${Response.TOKEN_LIMIT.toLocaleString()} tokens and was automatically truncated. Use browser_snapshot with filtering parameters for complete results.`;
      
      console.error(`[DEBUG] Applying emergency truncation from ${fullResponse.length} to ${truncated.length + warningMsg.length} characters`);
      
      const content: (TextContent | ImageContent)[] = [
        { type: 'text', text: truncated + warningMsg },
      ];

      return { content, isError: this._isError };
    }

    // Main response part
    const content: (TextContent | ImageContent)[] = [
      { type: 'text', text: fullResponse },
    ];

    // Image attachments.
    if (this._context.config.imageResponses !== 'omit') {
      for (const image of this._images)
        content.push({ type: 'image', data: image.data.toString('base64'), mimeType: image.contentType });
    }

    return { content, isError: this._isError };
  }
}

function renderTabSnapshot(tabSnapshot: TabSnapshot): string {
  const lines: string[] = [];

  if (tabSnapshot.consoleMessages.length) {
    lines.push(`### New console messages`);
    for (const message of tabSnapshot.consoleMessages)
      lines.push(`- ${trim(message.toString(), 100)}`);
    lines.push('');
  }

  if (tabSnapshot.downloads.length) {
    lines.push(`### Downloads`);
    for (const entry of tabSnapshot.downloads) {
      if (entry.finished)
        lines.push(`- Downloaded file ${entry.download.suggestedFilename()} to ${entry.outputFile}`);
      else
        lines.push(`- Downloading file ${entry.download.suggestedFilename()} ...`);
    }
    lines.push('');
  }

  lines.push(`### Page state`);
  lines.push(`- Page URL: ${tabSnapshot.url}`);
  lines.push(`- Page Title: ${tabSnapshot.title}`);
  lines.push(`- Page Snapshot:`);
  lines.push('```yaml');
  lines.push(tabSnapshot.ariaSnapshot);
  lines.push('```');

  return lines.join('\n');
}

function renderTabsMarkdown(tabs: Tab[], force: boolean = false): string[] {
  if (tabs.length === 1 && !force)
    return [];

  if (!tabs.length) {
    return [
      '### Open tabs',
      'No open tabs. Use the "browser_navigate" tool to navigate to a page first.',
      '',
    ];
  }

  const lines: string[] = ['### Open tabs'];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const current = tab.isCurrentTab() ? ' (current)' : '';
    lines.push(`- ${i}:${current} [${tab.lastTitle()}] (${tab.page.url()})`);
  }
  lines.push('');
  return lines;
}

function trim(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.slice(0, maxLength) + '...';
}
