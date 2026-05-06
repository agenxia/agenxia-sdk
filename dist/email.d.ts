export interface SendEmailResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
export declare function sendEmail(to: string, subject: string, content: string): Promise<SendEmailResult>;
//# sourceMappingURL=email.d.ts.map