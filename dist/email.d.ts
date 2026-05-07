export interface SendEmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
export type EmailContent = string | {
    html: string;
    text?: string;
};
export declare function sendEmail(to: string, subject: string, content: EmailContent): Promise<SendEmailResult>;
//# sourceMappingURL=email.d.ts.map