// Test setup file - runs before all tests.
// Hosts that run the suite inside a production build (Render sets
// NODE_ENV=production for `build:prod`) must not trip the production-only
// guards: missing AWS/Stripe credentials are what the mock-mode specs test.
process.env.NODE_ENV = 'test';
// Disable NURSERY_MODE for tests to ensure proper authentication behavior
process.env.NURSERY_MODE = 'false';
