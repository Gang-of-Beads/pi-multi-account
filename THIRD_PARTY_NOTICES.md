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
That notice is reproduced here in full, as MIT requires, because roughly 480
lines of `billing.ts` and `subscription-credentials.ts` derive from it:

```
MIT License

Copyright (c) 2025 pankajudhas81

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @narumitw/pi-accounts

- Package: https://www.npmjs.com/package/@narumitw/pi-accounts
- Role here: runtime dependency providing the multi-account store, `/accounts`
  command, and runtime OAuth account switching.

This dependency is not vendored into this repository; it is installed from npm
at package install time.
