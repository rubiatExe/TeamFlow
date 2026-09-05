const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const MOCK_MODE = !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN;

interface SendSMSParams {
    to: string;
    message: string;
}

interface SMSResult {
    success: boolean;
    messageId?: string;
    error?: string;
    mock?: boolean;
}

/**
 * Send an SMS via Twilio (or mock if no credentials)
 */
export async function sendSMS({ to, message }: SendSMSParams): Promise<SMSResult> {
    if (MOCK_MODE) {
        // Phone numbers, message bodies, and bearer links must never enter logs.
        console.log('[SMS] Mock delivery simulated');
        return { success: true, messageId: `mock_${Date.now()}`, mock: true };
    }

    try {
        const authString = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

        const response = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    To: to,
                    From: TWILIO_PHONE_NUMBER!,
                    Body: message,
                }),
            }
        );

        if (!response.ok) {
            // Drain the response without logging or returning provider-controlled text.
            await response.text();
            console.error('[SMS] Provider rejected delivery', { status: response.status });
            return { success: false, error: 'SMS provider rejected delivery' };
        }

        const data = await response.json();
        return { success: true, messageId: data.sid };
    } catch (error) {
        console.error('[SMS] Delivery failed', {
            errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        return { success: false, error: 'SMS delivery failed' };
    }
}

/**
 * Send an interview invitation SMS
 */
export async function sendInviteSMS(params: {
    candidateName: string;
    candidatePhone: string;
    storeName: string;
    magicLink: string;
}): Promise<SMSResult> {
    const { candidateName, candidatePhone, storeName, magicLink } = params;

    const message = `Hi ${candidateName}! 👋 ${storeName} loved your resume. Complete your quick application here: ${magicLink}`;

    return sendSMS({ to: candidatePhone, message });
}
