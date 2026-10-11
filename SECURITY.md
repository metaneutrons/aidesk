# Security policy

The intended reporting route is GitHub private vulnerability reporting. It is
currently disabled; enabling it is blocked by the connected integration's
administration permissions. Until it is enabled, contact the repository owner
privately. Never post credentials, portal grants or private customer messages
in public issues. Target an initial response within seven days after receipt.

The development stack binds services to loopback and uses generated local
credentials. It is not a public deployment configuration. Production requires
TLS, verified origins, protected secrets and scoped integration accounts.
