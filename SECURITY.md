# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of Crux Garden seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please do NOT:

- Open a public GitHub issue for security vulnerabilities
- Publicly disclose the vulnerability before it has been addressed

### Please DO:

1. **Report privately** - Email security details to [keeper@crux.garden](mailto:keeper@crux.garden)
2. **Provide details** - Include steps to reproduce, potential impact, and any suggested fixes
3. **Allow time** - Give us reasonable time to address the issue before any public disclosure

### What to include in your report:

- Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
- Full paths of source file(s) related to the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability, including how an attacker might exploit it

### What to expect:

- **Acknowledgment** - We will acknowledge receipt of your vulnerability report within 48 hours
- **Assessment** - We will assess the vulnerability and determine its impact and severity
- **Updates** - We will send you regular updates about our progress
- **Resolution** - Once the vulnerability is fixed, we will notify you and may publicly disclose it (with your permission)
- **Credit** - We will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Best Practices

When deploying Crux Garden, please ensure:

### Environment Variables
- Never commit `.env` files to version control
- Use strong, unique values for `JWT_SECRET`
- Rotate secrets regularly
- Use environment-specific configurations

### Database Security
- Use strong database passwords
- Enable SSL/TLS for database connections
- Restrict database access to only required IP addresses
- Regularly backup your database

### API Security
- Always use HTTPS in production
- Implement rate limiting
- Keep dependencies up to date
- Monitor for suspicious activity

### Authentication
- Use secure session management
- Implement proper token expiration
- Never store sensitive data in JWT payloads
- Use refresh token rotation

## Security Updates

Security updates will be released as soon as possible after a vulnerability is confirmed. Subscribe to GitHub releases or watch this repository to stay informed about security updates.

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [NestJS Security Best Practices](https://docs.nestjs.com/security/authentication)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

## Contact

For security concerns, please contact us at [keeper@crux.garden](mailto:keeper@crux.garden).

Thank you for helping keep Crux Garden and our users safe!
