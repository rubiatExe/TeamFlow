import { CandidateWithStatus } from '@/components/candidate-board';

// Demo candidates to showcase the dashboard — mixed roles
export const demoCandidates: CandidateWithStatus[] = [
    {
        id: 'demo_1',
        status: 'new',
        data: {
            candidate: {
                name: 'Sarah Chen',
                email: 'sarah.chen@email.com',
                phone: '(201) 555-0123',
                city: 'Hoboken, NJ',
                skills: ['Espresso', 'Latte Art', 'Customer Service', 'POS Systems'],
                experience_years: 3,
                applied_role: 'barista',
            },
            score: {
                total: 92,
                breakdown: { constraints: 48, experience: 28, logistics: 16 },
                explanation: 'Excellent match. 3 years barista experience, latte art certified, lives 10 mins away. Available weekends.',
            },
            red_flags: [],
        },
    },
    {
        id: 'demo_2',
        status: 'new',
        data: {
            candidate: {
                name: 'Marcus Johnson',
                email: 'marcus.j@email.com',
                phone: '(201) 555-0456',
                city: 'Jersey City, NJ',
                skills: ['Team Management', 'Scheduling', 'Cash Handling', 'Training'],
                experience_years: 5,
                applied_role: 'shift_lead',
            },
            score: {
                total: 87,
                breakdown: { constraints: 45, experience: 30, logistics: 12 },
                explanation: 'Strong candidate with leadership experience. Previously managed a team of 4. Weekend and closing availability confirmed.',
            },
            red_flags: [],
        },
    },
    {
        id: 'demo_3',
        status: 'new',
        data: {
            candidate: {
                name: 'Alex Rivera',
                email: 'alex.r@email.com',
                phone: '(973) 555-0789',
                city: 'Newark, NJ',
                skills: ['Customer Service', 'Cash Handling'],
                experience_years: 1,
                applied_role: 'cashier',
            },
            score: {
                total: 64,
                breakdown: { constraints: 40, experience: 15, logistics: 9 },
                explanation: 'Entry level, but eager to learn. No POS experience but strong retail background. 25 min commute.',
            },
            red_flags: ['No POS experience'],
        },
    },
    {
        id: 'demo_4',
        status: 'invited',
        data: {
            candidate: {
                name: 'Emily Park',
                email: 'emily.park@email.com',
                phone: '(201) 555-0321',
                city: 'Jersey City, NJ',
                skills: ['Knife Skills', 'Food Prep', 'Grill/Flat-top', 'Food Safety'],
                experience_years: 2,
                applied_role: 'line_cook',
            },
            score: {
                total: 88,
                breakdown: { constraints: 50, experience: 22, logistics: 16 },
                explanation: 'Great fit for line cook. Weekend availability confirmed. Food handlers permit current. Lives 5 mins from store.',
            },
            red_flags: [],
        },
    },
    {
        id: 'demo_5',
        status: 'interviewed',
        data: {
            candidate: {
                name: 'James Wilson',
                email: 'jwilson@email.com',
                phone: '(201) 555-0654',
                city: 'Bayonne, NJ',
                skills: ['Baking from Scratch', 'Recipe Scaling', 'Oven Operation', 'Sourdough'],
                experience_years: 4,
                applied_role: 'baker',
            },
            score: {
                total: 85,
                breakdown: { constraints: 45, experience: 28, logistics: 12 },
                explanation: 'Experienced baker with sourdough specialty. Early morning availability confirmed. Interviewed well, passionate about artisan baking.',
            },
            red_flags: [],
        },
    },
    {
        id: 'demo_6',
        status: 'hired',
        data: {
            candidate: {
                name: 'Maria Santos',
                email: 'maria.santos@email.com',
                phone: '(201) 555-0987',
                city: 'Jersey City, NJ',
                skills: ['Barista', 'Spanish Speaker', 'Opener'],
                experience_years: 2,
                applied_role: 'barista',
            },
            score: {
                total: 90,
                breakdown: { constraints: 50, experience: 24, logistics: 16 },
                explanation: 'Perfect schedule fit for morning shifts. Bilingual - great for our diverse customer base. Started last Monday!',
            },
            red_flags: [],
        },
    },
];
