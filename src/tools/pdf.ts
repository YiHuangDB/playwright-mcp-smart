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
import type { Page } from 'playwright';

const pdfSchema = z.object({
  filename: z.string().optional().describe('File name to save the pdf to. Defaults to `page-{timestamp}.pdf` if not specified.'),
  format: z.enum(['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6']).optional().describe('Paper format. Defaults to A4.'),
  landscape: z.boolean().optional().describe('Paper orientation. Defaults to false (portrait).'),
  printBackground: z.boolean().optional().describe('Print background graphics. Defaults to false.'),
  scale: z.number().min(0.1).max(2).optional().describe('Scale of the webpage rendering. Defaults to 1. Scale amount must be between 0.1 and 2.'),
  margin: z.object({
    top: z.string().optional().describe('Top margin, accepts values labeled with units.'),
    bottom: z.string().optional().describe('Bottom margin, accepts values labeled with units.'),
    left: z.string().optional().describe('Left margin, accepts values labeled with units.'),
    right: z.string().optional().describe('Right margin, accepts values labeled with units.'),
  }).optional().describe('Paper margins, defaults to none.'),
  width: z.string().optional().describe('Paper width, accepts values labeled with units.'),
  height: z.string().optional().describe('Paper height, accepts values labeled with units.'),
  preferCSSPageSize: z.boolean().optional().describe('Give any CSS @page size declared in the page priority over what is declared in width and height or format options.'),
  emulateMedia: z.enum(['screen', 'print']).optional().describe('Changes the CSS media type of the page. Defaults to print.'),
  outline: z.boolean().optional().describe('Whether to embed the document outline into the PDF.'),
  tagged: z.boolean().optional().describe('Generate tagged (accessible) PDF.'),
});

const pdf = defineTabTool({
  capability: 'pdf',

  schema: {
    name: 'browser_pdf_save',
    title: 'Save as PDF',
    description: 'Save page as PDF using browser print functionality with full page support and customizable options',
    inputSchema: pdfSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const fileName = await tab.context.outputFile(params.filename ?? `page-${new Date().toISOString()}.pdf`);
    
    // Build PDF options
    const pdfOptions: Parameters<Page['pdf']>[0] = {
      path: fileName,
    };
    
    // Apply format or custom dimensions
    if (params.format) {
      pdfOptions.format = params.format;
    } else if (params.width || params.height) {
      if (params.width) pdfOptions.width = params.width;
      if (params.height) pdfOptions.height = params.height;
    } else {
      pdfOptions.format = 'A4'; // Default format
    }
    
    // Apply other options
    if (params.landscape !== undefined) pdfOptions.landscape = params.landscape;
    if (params.printBackground !== undefined) pdfOptions.printBackground = params.printBackground;
    if (params.scale !== undefined) pdfOptions.scale = params.scale;
    if (params.margin) pdfOptions.margin = params.margin;
    if (params.preferCSSPageSize !== undefined) pdfOptions.preferCSSPageSize = params.preferCSSPageSize;
    if (params.outline !== undefined) pdfOptions.outline = params.outline;
    if (params.tagged !== undefined) pdfOptions.tagged = params.tagged;
    
    // Handle media emulation
    const mediaType = params.emulateMedia || 'print';
    if (mediaType !== 'print') {
      response.addCode(`await page.emulateMedia({ media: '${mediaType}' });`);
      await tab.page.emulateMedia({ media: mediaType });
    }
    
    response.addCode(`await page.pdf(${javascript.formatObject(pdfOptions)});`);
    
    await tab.page.pdf(pdfOptions);
    
    const formatDescription = params.format || (params.width || params.height ? 'custom size' : 'A4');
    const orientationDescription = params.landscape ? 'landscape' : 'portrait';
    response.addResult(`Saved full page as PDF (${formatDescription}, ${orientationDescription}) to ${fileName}`);
  },
});

export default [
  pdf,
];
