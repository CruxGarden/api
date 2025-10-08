/**
 * Mock Email service for integration testing
 */
export class MockEmailService {
  private sentEmails: Array<{
    email: string;
    subject: string;
    body: string;
  }> = [];

  async send(params: {
    email: string;
    subject: string;
    body: string;
  }): Promise<void> {
    this.sentEmails.push(params);
  }

  // Test helper methods
  getSentEmails() {
    return this.sentEmails;
  }

  getLastEmail() {
    return this.sentEmails[this.sentEmails.length - 1];
  }

  findEmailByAddress(email: string) {
    return this.sentEmails.find((e) => e.email === email);
  }

  extractCodeFromLastEmail(): string | null {
    const lastEmail = this.getLastEmail();
    if (!lastEmail) return null;

    // Extract code from email body: "Your auth code is {code}"
    const match = lastEmail.body.match(/Your auth code is (\S+)/);
    return match ? match[1] : null;
  }

  clear() {
    this.sentEmails = [];
  }

  getEmailCount(): number {
    return this.sentEmails.length;
  }
}
