
Install and run

* Install postgres (tested with debian postgresql-15)
* Make user and db: `su -s /bin/bash postgres` `createuser -drP hcg` `createdb -O hcg hcg`

```
export PGUSER=hcg
export PGDATABASE=hcg
export PGHOST=localhost
export PGPASSWORD=hcg
```

* Install Node.js: https://nodejs.org/en/download/package-manager
* Install deps: `corepack use && corepack pnpm i`
* Run `corepack pnpm tsx src/api.ts`

