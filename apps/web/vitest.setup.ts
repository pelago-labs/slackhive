/**
 * @fileoverview Vitest setup — populates env vars required by the secrets
 * module so tests can load modules that call getAuthSecret / getAdminPassword
 * at import or runtime without the fail-fast guard firing.
 */

process.env.AUTH_SECRET ??= 'test-auth-secret';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.ENV_SECRET_KEY ??= 'test-encryption-key';
