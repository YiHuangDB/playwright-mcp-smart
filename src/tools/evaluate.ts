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
import * as javascript from '../javascript.js';
import { generateLocator } from './utils.js';

import type * as playwright from 'playwright';

const evaluateSchema = z.object({
  function: z.string().describe('() => { /* code */ } or (element) => { /* code */ } when element is provided'),
  element: z.string().optional().describe('Human-readable element description used to obtain permission to interact with the element'),
  ref: z.string().optional().describe('Exact target element reference from the page snapshot'),
  maxLength: z.number().optional().describe('Maximum length of result to return (default: 10000 characters)'),
  returnSummary: z.boolean().optional().describe('Return a summary if result is too large (default: false)'),
});

const evaluate = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_evaluate',
    title: 'Evaluate JavaScript',
    description: 'Evaluate JavaScript expression on page or element',
    inputSchema: evaluateSchema,
    type: 'destructive',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    let locator: playwright.Locator | undefined;
    if (params.ref && params.element) {
      locator = await tab.refLocator({ ref: params.ref, element: params.element });
      response.addCode(`await page.${await generateLocator(locator)}.evaluate(${javascript.quote(params.function)});`);
    } else {
      response.addCode(`await page.evaluate(${javascript.quote(params.function)});`);
    }

    await tab.waitForCompletion(async () => {
      const receiver = locator ?? tab.page as any;
      const result = await receiver._evaluateFunction(params.function);
      const jsonResult = JSON.stringify(result, null, 2) || 'undefined';
      const maxLength = params.maxLength || 10000;
      
      // Check if result is too large
      if (jsonResult.length > maxLength) {
        if (params.returnSummary) {
          const truncated = jsonResult.slice(0, maxLength);
          const summary = {
            type: typeof result,
            length: jsonResult.length,
            preview: truncated,
            truncated: true,
            suggestion: 'Use maxLength parameter or set returnSummary: false for full result'
          };
          response.addResult(JSON.stringify(summary, null, 2));
          return;
        } else {
          // Check token limit
          const tokenCheck = response.checkTokenLimit(jsonResult);
          if (tokenCheck.needsPagination) {
            const message = `⚠️ JavaScript执行结果过大 (约${Math.ceil(jsonResult.length / 4).toLocaleString()} tokens)，超出限制 (24,000 tokens)。\n\n建议使用以下参数：\n\n` +
              `1. 限制长度: {"maxLength": ${maxLength}}\n` +
              `2. 返回摘要: {"returnSummary": true}\n` +
              `3. 修改JavaScript代码返回更小的数据集\n\n` +
              `结果预览 (前1000字符)：\n${jsonResult.slice(0, 1000)}...`;
            
            response.addResult(message);
            return;
          }
        }
      }
      
      response.addResult(jsonResult);
    });
  },
});

export default [
  evaluate,
];
