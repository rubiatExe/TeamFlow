
// Centralized café role definitions — criteria, skills, questionnaires
// This is the single source of truth for all role-specific logic across the app.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoleQuestion {
    id: string;
    question: string;
    type: 'boolean' | 'scale' | 'text' | 'select';
    options?: string[];
    minChars?: number;
    maxChars?: number;
    failValue?: string; // If answer equals this, candidate fails (for knockout questions)
}

export interface RoleSuperpower {
    id: string;
    label: string;
    emoji: string;
    desc: string;
}

export interface RoleSkill {
    id: string;
    label: string;
}

export interface RoleCertification {
    id: string;
    label: string;
}

export interface CafeRole {
    id: string;
    title: string;
    emoji: string;
    description: string;
    wageRange: { min: number; max: number };
    dealbreakers: string[];
    essentialSkills: RoleSkill[];
    niceToHaveSkills: RoleSkill[];
    certifications: RoleCertification[];
    superpowers: RoleSuperpower[];
    questions: {
        knockout: RoleQuestion[];
        skills: RoleQuestion[];
        motivation: RoleQuestion[];
    };
}

// ─── Role Definitions ────────────────────────────────────────────────────────

export const CAFE_ROLES: CafeRole[] = [
    // ── Barista ──────────────────────────────────────────────────────────────
    {
        id: 'barista',
        title: 'Barista',
        emoji: '☕',
        description: 'Front-of-house barista responsible for crafting espresso drinks, serving customers, and maintaining a clean workspace. Must thrive in fast-paced environments and deliver excellent customer service.',
        wageRange: { min: 15, max: 18 },
        dealbreakers: [
            'Weekend availability required',
            'Must be 18+',
            'Valid work authorization',
            "Food Handler's Permit required",
            'Reliable transportation',
        ],
        essentialSkills: [
            { id: 'espresso_machine', label: '☕ Espresso Machine' },
            { id: 'customer_service', label: '😊 Customer Service' },
            { id: 'pos_register', label: '💳 POS/Register' },
            { id: 'cash_handling', label: '💵 Cash Handling' },
            { id: 'drink_recipes', label: '🍹 Drink Recipes' },
            { id: 'milk_steaming', label: '🥛 Milk Steaming/Frothing' },
        ],
        niceToHaveSkills: [
            { id: 'latte_art', label: '🎨 Latte Art' },
            { id: 'coffee_knowledge', label: '🫘 Coffee Bean Knowledge' },
            { id: 'opening_closing', label: '🔑 Opening/Closing' },
            { id: 'inventory', label: '📦 Inventory Management' },
            { id: 'training', label: '👥 Training Others' },
            { id: 'bilingual', label: '🌍 Bilingual' },
        ],
        certifications: [
            { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
            { id: 'barista_cert', label: '☕ Barista Certification' },
            { id: 'servsafe', label: '✅ ServSafe Certified' },
            { id: 'first_aid', label: '🩹 First Aid/CPR' },
        ],
        superpowers: [
            { id: 'friendly', emoji: '😊', label: 'People person', desc: 'I make everyone feel welcome at the counter' },
            { id: 'fast', emoji: '⚡', label: 'Speed demon', desc: 'I can pull shots and steam milk simultaneously' },
            { id: 'calm', emoji: '🧘', label: 'Cool under pressure', desc: 'Rush hour? I keep the line moving smoothly' },
            { id: 'detail', emoji: '🔍', label: 'Detail-oriented', desc: 'Every drink leaves my station perfect' },
            { id: 'learner', emoji: '📚', label: 'Quick learner', desc: 'New menu items? Show me once and I got it' },
            { id: 'creative', emoji: '🎨', label: 'Creative', desc: 'I love experimenting with new drink combos' },
        ],
        questions: {
            knockout: [
                { id: 'bk_age', question: 'Are you at least 18 years of age?', type: 'boolean', failValue: 'no' },
                { id: 'bk_auth', question: 'Are you legally authorized to work in the US?', type: 'boolean', failValue: 'no' },
                { id: 'bk_weekend', question: 'Can you work at least one weekend day (Saturday or Sunday) every week?', type: 'boolean', failValue: 'no' },
                { id: 'bk_transport', question: 'Do you have reliable transportation to get to work on time?', type: 'boolean', failValue: 'no' },
            ],
            skills: [
                {
                    id: 'bs_espresso', question: 'Rate your experience with manual espresso machines (La Marzocca, Slayer, etc.):',
                    type: 'select', options: ['None', 'Beginner — trained but limited', 'Intermediate — confident on most machines', 'Pro — I can dial in any grinder']
                },
                {
                    id: 'bs_latte', question: 'Can you pour latte art (hearts, rosettas)?',
                    type: 'select', options: ['Not yet', 'Basic hearts', 'Hearts & tulips', 'Advanced — rosettas, swans']
                },
                {
                    id: 'bs_conflict', question: 'A customer says their oat milk latte tastes "wrong" during a packed morning rush. How do you handle it?',
                    type: 'text', minChars: 50, maxChars: 400
                },
            ],
            motivation: [
                {
                    id: 'bm_why', question: 'Why do you want to work at our café specifically?',
                    type: 'text', minChars: 50, maxChars: 500
                },
                {
                    id: 'bm_beyond', question: 'Tell us about a time you turned a frustrated customer into a happy regular.',
                    type: 'text', minChars: 0, maxChars: 400
                },
            ],
        },
    },

    // ── Shift Lead ───────────────────────────────────────────────────────────
    {
        id: 'shift_lead',
        title: 'Shift Lead',
        emoji: '👑',
        description: 'Supervise the floor team during shifts, handle cash-out, resolve customer escalations, and ensure food safety and cleanliness standards are met. Serves as acting manager when the owner is away.',
        wageRange: { min: 18, max: 22 },
        dealbreakers: [
            'Closing shift availability required',
            'Must be 21+ (alcohol service)',
            'Minimum 30 hours/week commitment',
            'Valid work authorization',
            "Food Handler's Permit required",
            'Weekend availability required',
        ],
        essentialSkills: [
            { id: 'team_management', label: '👥 Team Management' },
            { id: 'conflict_resolution', label: '🤝 Conflict Resolution' },
            { id: 'cash_handling', label: '💵 Cash Handling/Registers' },
            { id: 'scheduling', label: '📅 Scheduling' },
            { id: 'customer_service', label: '😊 Customer Service' },
            { id: 'opening_closing', label: '🔑 Opening/Closing Duties' },
        ],
        niceToHaveSkills: [
            { id: 'training', label: '🎓 Training New Hires' },
            { id: 'inventory', label: '📦 Inventory/Ordering' },
            { id: 'food_safety_mgmt', label: '🛡️ Food Safety Management' },
            { id: 'espresso_machine', label: '☕ Espresso Machine' },
            { id: 'bilingual', label: '🌍 Bilingual' },
            { id: 'pos_admin', label: '💻 POS Administration' },
        ],
        certifications: [
            { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
            { id: 'servsafe', label: '✅ ServSafe Manager' },
            { id: 'tips', label: '🍺 TIPS Alcohol Certification' },
            { id: 'first_aid', label: '🩹 First Aid/CPR' },
        ],
        superpowers: [
            { id: 'leader', emoji: '👑', label: 'Natural leader', desc: 'People look to me for guidance and direction' },
            { id: 'calm', emoji: '🧘', label: 'Cool under pressure', desc: 'I keep the team focused when things get hectic' },
            { id: 'problem_solver', emoji: '🧩', label: 'Problem solver', desc: 'I find solutions before issues become problems' },
            { id: 'accountable', emoji: '✅', label: 'Highly accountable', desc: 'The shift runs my way — clean, fast, zero shortcuts' },
            { id: 'mentor', emoji: '🤝', label: 'Mentor', desc: 'I love helping newer team members grow' },
            { id: 'multitasker', emoji: '🎯', label: 'Multitasker', desc: 'Register, floor, customer — I handle it all at once' },
        ],
        questions: {
            knockout: [
                { id: 'sk_age', question: 'Are you at least 21 years of age?', type: 'boolean', failValue: 'no' },
                { id: 'sk_auth', question: 'Are you legally authorized to work in the US?', type: 'boolean', failValue: 'no' },
                { id: 'sk_hours', question: 'Can you commit to a minimum of 30 hours per week?', type: 'boolean', failValue: 'no' },
                { id: 'sk_closing', question: 'Are you available for closing shifts (until 11 PM) at least 3 days per week?', type: 'boolean', failValue: 'no' },
                { id: 'sk_weekend', question: 'Can you work weekends regularly?', type: 'boolean', failValue: 'no' },
            ],
            skills: [
                {
                    id: 'ss_lead_exp', question: 'How many people have you directly supervised in a previous role?',
                    type: 'select', options: ['None yet', '1-3 people', '4-8 people', '9+ people']
                },
                {
                    id: 'ss_callout', question: 'Two team members call out sick 30 minutes before a Saturday morning rush. What do you do?',
                    type: 'text', minChars: 50, maxChars: 400
                },
                {
                    id: 'ss_training', question: 'Describe your approach to training a brand-new barista on their first day.',
                    type: 'text', minChars: 50, maxChars: 400
                },
            ],
            motivation: [
                {
                    id: 'sm_why', question: 'What excites you about stepping into a leadership role at our café?',
                    type: 'text', minChars: 50, maxChars: 500
                },
                {
                    id: 'sm_conflict', question: 'Tell us about a time you resolved a conflict between two coworkers.',
                    type: 'text', minChars: 0, maxChars: 400
                },
            ],
        },
    },

    // ── Line Cook ────────────────────────────────────────────────────────────
    {
        id: 'line_cook',
        title: 'Line Cook',
        emoji: '🍳',
        description: 'Back-of-house prep and line cook responsible for preparing menu items to spec, maintaining kitchen cleanliness, and managing food safety standards under high-volume conditions.',
        wageRange: { min: 16, max: 20 },
        dealbreakers: [
            'Weekend availability required',
            'Must be 18+',
            'Valid work authorization',
            "Food Handler's Permit required",
            'Able to lift 50 lbs repeatedly',
            'Comfortable standing for 8+ hour shifts',
        ],
        essentialSkills: [
            { id: 'knife_skills', label: '🔪 Knife Skills' },
            { id: 'grill_flattop', label: '🔥 Grill/Flat-top' },
            { id: 'food_prep', label: '🥗 Food Prep' },
            { id: 'food_safety', label: '🛡️ Food Safety/HACCP' },
            { id: 'ticket_management', label: '🎫 Ticket Management' },
            { id: 'cleaning_sanitation', label: '🧹 Cleaning/Sanitation' },
        ],
        niceToHaveSkills: [
            { id: 'sous_vide', label: '🫕 Sous Vide' },
            { id: 'combi_oven', label: '♨️ Combi Oven' },
            { id: 'pastry_basics', label: '🧁 Basic Pastry' },
            { id: 'inventory', label: '📦 Inventory/Receiving' },
            { id: 'plating', label: '🍽️ Plating/Presentation' },
            { id: 'bilingual', label: '🌍 Bilingual' },
        ],
        certifications: [
            { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
            { id: 'servsafe', label: '✅ ServSafe Certified' },
            { id: 'first_aid', label: '🩹 First Aid/CPR' },
        ],
        superpowers: [
            { id: 'fast', emoji: '⚡', label: 'Speed demon', desc: 'I keep tickets flying out during the rush' },
            { id: 'clean', emoji: '✨', label: 'Clean as you go', desc: 'My station stays spotless even when it is slammed' },
            { id: 'precise', emoji: '🎯', label: 'Precision', desc: 'Every plate looks exactly like the last one' },
            { id: 'tough', emoji: '💪', label: 'Iron endurance', desc: '12-hour shifts? I just keep going' },
            { id: 'team_player', emoji: '🤝', label: 'Team player', desc: 'I jump in wherever the line needs me' },
            { id: 'calm', emoji: '🧘', label: 'Cool under fire', desc: 'Even in a ticket avalanche, I stay focused' },
        ],
        questions: {
            knockout: [
                { id: 'lk_age', question: 'Are you at least 18 years of age?', type: 'boolean', failValue: 'no' },
                { id: 'lk_auth', question: 'Are you legally authorized to work in the US?', type: 'boolean', failValue: 'no' },
                { id: 'lk_lift', question: 'Are you comfortable lifting up to 50 lbs repeatedly throughout a shift?', type: 'boolean', failValue: 'no' },
                { id: 'lk_standing', question: 'Can you stand for 8+ hours during a shift?', type: 'boolean', failValue: 'no' },
                { id: 'lk_weekend', question: 'Can you work at least one weekend day per week?', type: 'boolean', failValue: 'no' },
            ],
            skills: [
                {
                    id: 'ls_volume', question: 'What is your experience with high-volume ticket management?',
                    type: 'select', options: ['No experience', 'Low volume (under 50 covers)', 'Medium (50-150 covers)', 'High volume (150+ covers)']
                },
                {
                    id: 'ls_equipment', question: 'Which kitchen equipment are you experienced with?',
                    type: 'select', options: ['Basic (home kitchen)', 'Flat-top & fryers', 'Full line (grill, sauté, oven)', 'Advanced (combi, sous vide, salamander)']
                },
                {
                    id: 'ls_pressure', question: 'You are in the weeds: 15 tickets hanging and a new order just came in with a food allergy note. Walk us through your next 60 seconds.',
                    type: 'text', minChars: 50, maxChars: 400
                },
            ],
            motivation: [
                {
                    id: 'lm_why', question: 'Why do you want to cook at our café?',
                    type: 'text', minChars: 50, maxChars: 500
                },
                {
                    id: 'lm_pride', question: 'Tell us about a dish or shift you are most proud of.',
                    type: 'text', minChars: 0, maxChars: 400
                },
            ],
        },
    },

    // ── Cashier ──────────────────────────────────────────────────────────────
    {
        id: 'cashier',
        title: 'Cashier',
        emoji: '💳',
        description: 'Front-of-house cashier responsible for greeting customers, processing transactions accurately, handling cash and card payments, and supporting the overall customer experience.',
        wageRange: { min: 14, max: 16 },
        dealbreakers: [
            'Weekend availability required',
            'Must be 18+',
            'Valid work authorization',
            'Reliable transportation',
        ],
        essentialSkills: [
            { id: 'pos_register', label: '💳 POS/Register Systems' },
            { id: 'cash_handling', label: '💵 Cash Handling' },
            { id: 'customer_service', label: '😊 Customer Service' },
            { id: 'basic_math', label: '🔢 Basic Math' },
            { id: 'order_accuracy', label: '✅ Order Accuracy' },
            { id: 'upselling', label: '📈 Upselling/Suggestive Selling' },
        ],
        niceToHaveSkills: [
            { id: 'bilingual', label: '🌍 Bilingual' },
            { id: 'food_knowledge', label: '🍽️ Menu Knowledge' },
            { id: 'cleaning', label: '🧹 Cleaning/Organization' },
            { id: 'phone_etiquette', label: '📞 Phone Etiquette' },
            { id: 'opening_closing', label: '🔑 Opening/Closing' },
            { id: 'loyalty_programs', label: '⭐ Loyalty Programs' },
        ],
        certifications: [
            { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
            { id: 'first_aid', label: '🩹 First Aid/CPR' },
        ],
        superpowers: [
            { id: 'friendly', emoji: '😊', label: 'People person', desc: 'I greet every customer like they are a regular' },
            { id: 'accurate', emoji: '🎯', label: 'Zero-error accuracy', desc: 'My register is always balanced at close' },
            { id: 'fast', emoji: '⚡', label: 'Quick on the register', desc: 'I keep the line moving without rushing anyone' },
            { id: 'upseller', emoji: '📈', label: 'Natural upseller', desc: 'I suggest add-ons without being pushy' },
            { id: 'calm', emoji: '🧘', label: 'Patient and calm', desc: 'Even difficult customers leave with a smile' },
            { id: 'organized', emoji: '📋', label: 'Super organized', desc: 'Counter stays clean, receipts are tidy, supplies stocked' },
        ],
        questions: {
            knockout: [
                { id: 'ck_age', question: 'Are you at least 18 years of age?', type: 'boolean', failValue: 'no' },
                { id: 'ck_auth', question: 'Are you legally authorized to work in the US?', type: 'boolean', failValue: 'no' },
                { id: 'ck_weekend', question: 'Can you work at least one weekend day per week?', type: 'boolean', failValue: 'no' },
                { id: 'ck_transport', question: 'Do you have reliable transportation to get to work on time?', type: 'boolean', failValue: 'no' },
            ],
            skills: [
                {
                    id: 'cs_pos', question: 'Which POS or register systems have you used before?',
                    type: 'select', options: ['None — first time', 'Square POS', 'Toast / Clover / Other', 'Multiple systems — very comfortable']
                },
                {
                    id: 'cs_discrepancy', question: 'At the end of your shift, your register drawer is $20 short. What steps do you take?',
                    type: 'text', minChars: 50, maxChars: 400
                },
                {
                    id: 'cs_upsell', question: 'A customer orders a plain black coffee. How would you naturally suggest an add-on or upgrade?',
                    type: 'text', minChars: 30, maxChars: 300
                },
            ],
            motivation: [
                {
                    id: 'cm_why', question: 'Why are you interested in working as a cashier at our café?',
                    type: 'text', minChars: 50, maxChars: 500
                },
                {
                    id: 'cm_customer', question: 'Describe a time you turned a negative customer interaction into a positive one.',
                    type: 'text', minChars: 0, maxChars: 400
                },
            ],
        },
    },

    // ── Baker / Pastry ───────────────────────────────────────────────────────
    {
        id: 'baker',
        title: 'Baker / Pastry',
        emoji: '🥐',
        description: 'Back-of-house baker responsible for preparing pastries, breads, and baked goods from scratch. Requires early-morning availability and precise attention to recipes, timing, and presentation.',
        wageRange: { min: 16, max: 20 },
        dealbreakers: [
            'Early morning availability (4-5 AM start)',
            'Must be 18+',
            'Valid work authorization',
            "Food Handler's Permit required",
            'Able to lift 50 lbs (flour bags, sheet trays)',
        ],
        essentialSkills: [
            { id: 'baking_scratch', label: '🍞 Baking from Scratch' },
            { id: 'recipe_scaling', label: '📐 Recipe Scaling' },
            { id: 'oven_operation', label: '♨️ Oven Operation' },
            { id: 'dough_handling', label: '🫗 Dough Handling/Shaping' },
            { id: 'food_safety', label: '🛡️ Food Safety' },
            { id: 'time_management', label: '⏰ Time Management' },
        ],
        niceToHaveSkills: [
            { id: 'pastry_decoration', label: '🎂 Pastry Decoration' },
            { id: 'sourdough', label: '🫘 Sourdough/Fermentation' },
            { id: 'lamination', label: '🥐 Laminated Doughs' },
            { id: 'inventory', label: '📦 Inventory/Ordering' },
            { id: 'gluten_free', label: '🌾 Gluten-Free/Allergen Baking' },
            { id: 'plating', label: '🍽️ Display/Plating' },
        ],
        certifications: [
            { id: 'food_handler', label: "🍽️ Food Handler's Permit" },
            { id: 'servsafe', label: '✅ ServSafe Certified' },
            { id: 'pastry_cert', label: '🎂 Pastry Arts Certification' },
            { id: 'first_aid', label: '🩹 First Aid/CPR' },
        ],
        superpowers: [
            { id: 'early_bird', emoji: '🌅', label: 'Early bird', desc: '4 AM start? I am already at the oven' },
            { id: 'precise', emoji: '📐', label: 'Precision', desc: 'I measure everything to the gram' },
            { id: 'creative', emoji: '🎨', label: 'Creative baker', desc: 'I love developing new recipes and seasonal items' },
            { id: 'consistent', emoji: '🔁', label: 'Consistent', desc: 'Every croissant comes out perfect, every single day' },
            { id: 'efficient', emoji: '⚡', label: 'Efficient', desc: 'I manage multiple timers and batches seamlessly' },
            { id: 'clean', emoji: '✨', label: 'Clean baker', desc: 'My station stays spotless even mid-production' },
        ],
        questions: {
            knockout: [
                { id: 'pk_age', question: 'Are you at least 18 years of age?', type: 'boolean', failValue: 'no' },
                { id: 'pk_auth', question: 'Are you legally authorized to work in the US?', type: 'boolean', failValue: 'no' },
                { id: 'pk_early', question: 'Can you consistently start shifts at 4-5 AM?', type: 'boolean', failValue: 'no' },
                { id: 'pk_lift', question: 'Are you comfortable lifting up to 50 lbs (flour bags, sheet trays)?', type: 'boolean', failValue: 'no' },
            ],
            skills: [
                {
                    id: 'ps_scratch', question: 'What is your experience level with baking from scratch?',
                    type: 'select', options: ['Home baker', 'Some professional training', 'Experienced — worked in a bakery', 'Advanced — pastry school or 3+ years pro']
                },
                {
                    id: 'ps_scaling', question: 'You need to scale a recipe from 2 dozen muffins to 15 dozen. The original calls for 3¼ cups flour. How much flour do you need?',
                    type: 'text', minChars: 5, maxChars: 200
                },
                {
                    id: 'ps_timing', question: 'Describe how you manage multiple items in the oven with different bake times and temperatures.',
                    type: 'text', minChars: 50, maxChars: 400
                },
            ],
            motivation: [
                {
                    id: 'pm_why', question: 'What excites you about baking for our café?',
                    type: 'text', minChars: 50, maxChars: 500
                },
                {
                    id: 'pm_signature', question: 'If you could add one signature item to our pastry case, what would it be and why?',
                    type: 'text', minChars: 0, maxChars: 400
                },
            ],
        },
    },
];

// ─── Helper Functions ────────────────────────────────────────────────────────

export function getRoleById(roleId: string): CafeRole | undefined {
    return CAFE_ROLES.find(r => r.id === roleId);
}

export function getRoleOrDefault(roleId?: string): CafeRole {
    return getRoleById(roleId || 'barista') || CAFE_ROLES[0];
}

export function getAllRoleIds(): string[] {
    return CAFE_ROLES.map(r => r.id);
}

export function getRoleTitles(): { id: string; title: string; emoji: string }[] {
    return CAFE_ROLES.map(r => ({ id: r.id, title: r.title, emoji: r.emoji }));
}
