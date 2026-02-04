
import { ParserInput } from '../app/api/types';

async function main() {
    const PARSER_ENDPOINT = 'http://localhost:3000/api/parser';

    // 1. Define Dummy Input (The API will fetch this URL)
    // We use a public PDF or just a dummy one since our Mock Nougat doesn't actually read the file content yet
    // but the API tries to fetch it.
    // Let's us a placeholder that won't fail the "fetch" call if we mock that too or ensure it exists.
    // Actually, the API does: const fileRes = await fetch(fileUrl);
    // So we need a valid URL. Let's use a public PDF or mock the fetch in the API?
    // Or just use a widely available public PDF.
    const payload: ParserInput = {
        fileUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
        jobId: undefined
    };

    console.log(`Testing Pipeline at ${PARSER_ENDPOINT}...`);
    console.log('Payload:', payload);

    try {
        const res = await fetch(PARSER_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error('API Error:', res.status, res.statusText);
            const text = await res.text();
            console.error('Response:', text);
            process.exit(1);
        }

        const data = await res.json();
        console.log('✅ Pipeline Success!');
        console.log('Response Data:', JSON.stringify(data, null, 2));

        // Simple Assertions
        if (data.candidate && data.score && data.score.total >= 0) {
            console.log('✅ Structure Valid: Candidate and Score present.');
        } else {
            console.error('❌ Structure Invalid');
            process.exit(1);
        }

    } catch (err) {
        console.error('Network Error:', err);
        process.exit(1);
    }
}

main();
