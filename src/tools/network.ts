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

import type * as playwright from 'playwright';

const networkSchema = z.object({
  limit: z.number().optional().describe('Maximum number of requests to return (default: 100)'),
  offset: z.number().optional().describe('Number of requests to skip for pagination (default: 0)'),
});

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns all network requests since loading the page',
    inputSchema: networkSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const requests = tab.requests();
    const requestEntries = [...requests.entries()];
    const limit = params.limit || 100;
    const offset = params.offset || 0;
    
    // Check if we need pagination before processing
    if (!params.limit && !params.offset) {
      const allContent = requestEntries.map(([req, res]) => renderRequest(req, res)).join('\n');
      const tokenCheck = response.checkTokenLimit(allContent);
      
      if (tokenCheck.needsPagination) {
        response.addPaginationWarning(tokenCheck.totalPages!, 'browser_network_requests');
        return;
      }
    }
    
    // Apply pagination
    const paginatedEntries = requestEntries.slice(offset, offset + limit);
    const hasMore = offset + limit < requestEntries.length;
    
    if (paginatedEntries.length === 0) {
      response.addResult('No network requests found in the specified range.');
      return;
    }
    
    // Add pagination info
    if (params.limit || params.offset) {
      response.addResult(`Network requests ${offset + 1}-${offset + paginatedEntries.length} of ${requestEntries.length}:`);
    }
    
    paginatedEntries.forEach(([req, res]) => response.addResult(renderRequest(req, res)));
    
    // Add next page hint if there are more results
    if (hasMore) {
      const nextOffset = offset + limit;
      response.addResult(`\n📄 More results available. Next page: {"limit": ${limit}, "offset": ${nextOffset}}`);
    }
  },
});

function renderRequest(request: playwright.Request, response: playwright.Response | null) {
  const result: string[] = [];
  result.push(`[${request.method().toUpperCase()}] ${request.url()}`);
  if (response)
    result.push(`=> [${response.status()}] ${response.statusText()}`);
  return result.join(' ');
}

export default [
  requests,
];
