HCGateway API
=============

Backend is completely remade in this fork.  Original was python API
read/write server in
[HCGateway](https://github.com/CoolCoderSJ/HCGateway).

This backend (in TypeScript) will use a PostgreSQL server for
authentication, creating a new database per user that they then may
access with their credentials.

This allows using the data in [Looker
Studio](https://lookerstudio.google.com/), or any other visualization
tool that can connect to PSQL.


Install and run
---------------

* Install postgres (tested with debian postgresql-15)
* Make user and db: `su -s /bin/bash postgres` `createuser -drP hcg` `createdb -O hcg hcg`

Set environment for database:

```
export PGUSER=hcg
export PGDATABASE=hcg
export PGHOST=localhost
export PGPASSWORD=hcg
```
(yes, of course you should use a proper password...)


* Install Node.js: https://nodejs.org/en/download/package-manager
* Install deps: `corepack enable && corepack pnpm i`
* Run `corepack pnpm start`


Some TODO to not forget:

- Safe up psql values for sql injections (username and app sync endpoint could be used by hacker)
