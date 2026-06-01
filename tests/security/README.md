# Cross-tenant regression guards

`tenant-isolation.test.ts` locks in the service-role route fixes that stop a
company_admin of one tenant from reading/mutating another tenant's data (the
service-role client bypasses RLS, so the route's `verifyAccountAccess` /
`getAllowedAccountIds` check is the only guard). Each case asserts cross-tenant
access is rejected (403 / empty scope) while same-company and `super_admin` are
allowed.

**Adding a guard for a new service-role route:** import its handler after the
`@/lib/supabase-server` mock (see this suite's fixture), then assert
`company_admin` of company A gets 403 against a company B `account_id`/`id`,
own-company succeeds, and `super_admin` bypasses scope.
