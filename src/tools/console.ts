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

import { z } from 'zod';
import { defineTabTool } from './tool.js';

const consoleSchema = z.object({
  limit: z.number().optional().describe('Maximum number of console messages to return (default: 100)'),
  offset: z.number().optional().describe('Number of messages to skip for pagination (default: 0)'),
});

const console = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_console_messages',
    title: 'Get console messages',
    description: 'Returns all console messages',
    inputSchema: consoleSchema,
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const messages = tab.consoleMessages();
    const limit = params.limit || 100;
    const offset = params.offset || 0;
    
    // Check if we need pagination before processing
    if (!params.limit && !params.offset) {
      const allContent = messages.map(message => message.toString()).join('\n');
      const tokenCheck = response.checkTokenLimit(allContent);
      
      if (tokenCheck.needsPagination) {
        response.addPaginationWarning(tokenCheck.totalPages!, 'browser_console_messages');
        return;
      }
    }
    
    // Apply pagination
    const paginatedMessages = messages.slice(offset, offset + limit);
    const hasMore = offset + limit < messages.length;
    
    if (paginatedMessages.length === 0) {
      response.addResult('No console messages found in the specified range.');
      return;
    }
    
    // Add pagination info
    if (params.limit || params.offset) {
      response.addResult(`Console messages ${offset + 1}-${offset + paginatedMessages.length} of ${messages.length}:`);
    }
    
    paginatedMessages.forEach(message => response.addResult(message.toString()));
    
    // Add next page hint if there are more results
    if (hasMore) {
      const nextOffset = offset + limit;
      response.addResult(`\n📄 More messages available. Next page: {"limit": ${limit}, "offset": ${nextOffset}}`);
    }
  },
});

export default [
  console,
];
