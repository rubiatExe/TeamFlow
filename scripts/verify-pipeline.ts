
import { readFileSync } from 'node:fs';

import {
    ParserOutputSchema,
    type ParserInput,
} from '../lib/contracts/parser.ts';

async function main() {
    const PARSER_ENDPOINT = 'http://localhost:3000/api/parser';

    const fixture = readFileSync(new URL(
        '../services/document-processor/tests/fixtures/digital-resume.pdf',
        import.meta.url,
    ));
    const payload: ParserInput = {
        fileData: fixture.toString('base64'),
        mimeType: 'application/pdf',
        fileName: 'synthetic-digital-resume.pdf',
    };

    console.log(`Testing Pipeline at ${PARSER_ENDPOINT}...`);
    console.log(`Using synthetic PDF fixture (${fixture.byteLength} bytes).`);

    try {
        const res = await fetch(PARSER_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error('API Error:', res.status, res.statusText);
            process.exit(1);
        }

        const data = await res.json();
        const parsed = ParserOutputSchema.safeParse(data);
        if (!parsed.success) {
            console.error('Pipeline returned an invalid response contract.');
            process.exit(1);
        }
        console.log('Pipeline response contract is valid.');

    } catch (err) {
        console.error('Pipeline request failed:',
            err instanceof Error ? err.name : 'UnknownError');
        process.exit(1);
    }
}

main();
