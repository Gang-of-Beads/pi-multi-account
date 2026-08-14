# Third-Party Notices

This project includes or adapts code from the following third-party projects:

## pi-claude-auth

- Repository: https://github.com/pankajudhas81/pi-claude-auth
- License: MIT
- Adapted files in this repository:
  - `billing.ts`
  - `subscription-credentials.ts`

The original project is MIT licensed. Its license permits use, modification,
and redistribution, provided the copyright and permission notice are preserved.

## @narumitw/pi-accounts

- Package: https://www.npmjs.com/package/@narumitw/pi-accounts
- Role here: runtime dependency providing the multi-account store, `/accounts`
  command, and runtime OAuth account switching.

This dependency is not vendored into this repository; it is installed from npm
at package install time.
