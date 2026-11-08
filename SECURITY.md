# Security

This project handles database credentials, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub's **Report a vulnerability** button on the repository's Security tab. Include the affected route or file, the steps to reproduce, and the impact you expect.

We will confirm receipt, keep you informed while we fix it, and credit you in the release notes unless you prefer otherwise.

## Scope

In scope: the Worker code in this repository, including authentication, the cookie and session handling, CSRF checks and the in-process TLS client.

Vulnerabilities that also exist in phpMyAdmin 5.2.3 itself should be reported to the phpMyAdmin project as well (https://www.phpmyadmin.net/security/), since this port reproduces its behavior.
