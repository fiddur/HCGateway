import { json } from 'body-parser'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { Client } from 'pg'
import format from 'pg-format'
import polka from 'polka'
import { EnergyResult } from 'react-native-health-connect'

const recordTypes = {
  'ActiveCaloriesBurned': {
    fields: {
      inCalories: 'FLOAT8',
      inJoules: 'FLOAT8',
      inKilocalories: 'FLOAT8',
      inKilojoules: 'FLOAT8',
    },
    transform: (item: RecordItem) => ({
      inCalories:  'FLOAT8',
      inJoules: 'FLOAT8',
      inKilocalories: 'FLOAT8',
      inKilojoules: 'FLOAT8',
    })
  },
  //   'BasalBodyTemperature',
  //   'BloodGlucose',
  //   'BloodPressure',
  //   'BasalMetabolicRate',
  //   'BodyFat',
  //   'BodyTemperature',
  //   'BoneMass',
  //   'CyclingPedalingCadence',
  //   'CervicalMucus',
  //   'ExerciseSession',
  //   'Distance',
  //   'ElevationGained',
  //   'FloorsClimbed',
  //   'HeartRate',
  //   'Height',
  //   'Hydration',
  //   'LeanBodyMass',
  //   'MenstruationFlow',
  //   'MenstruationPeriod',
  //   'Nutrition',
  //   'OvulationTest',
  //   'OxygenSaturation',
  //   'Power',
  //   'RespiratoryRate',
  //   'RestingHeartRate',
  //   'SleepSession',
  //   'Speed',
  //   'Steps',
  //   'StepsCadence',
  //   'TotalCaloriesBurned',
  //   'Vo2Max',
  //   'Weight',
  //   'WheelchairPushes',
}

const formatValue = (v: unknown): string =>
  Array.isArray(v)
    ? `'{ "${v.join('","')}" }'`
    : typeof v === 'number'
      ? String(v)
      : typeof v === 'boolean'
        ? String(v)
        : v === null
          ? 'NULL'
          : typeof v === 'string'
            ? `'${(v as string).replaceAll("'", "''")}'`
            : `'${JSON.stringify(v).replaceAll("'", "''")}'`

type RecordItem = {
  metadata: {
    id: string
    dataOrigin: string
  }
  time?: string
  startTime?: string
  endTime?: string
  energy?: EnergyResult
  [k: string]: string | number
}

const baseFields = {
  id: 'VARCHAR PRIMARY KEY',
  time: 'TIMESTAMP',
  startTime: 'TIMESTAMP',
  endTime: 'TIMESTAMP',
  metadata: 'JSONB',
  app: 'VARCHAR',
}
  
const fieldsByType = (recordType: keyof typeof recordTypes) => ({ ...baseFields, ...recordTypes[recordType].fields })

const main = async () => {
  const config = {
    sessionSalt: 'very very secretvery very secret', //  256-bit encryption key (32 bytes)
  }
  const iv = randomBytes(12).toString('base64')
  const cipher = createCipheriv('aes-256-gcm', config.sessionSalt, iv)

  const httpd = polka()
  const dbByUser: Record<string, Client> = {}

  const userDbName = (user: string) => `hcg-${user}`
  const getDbForUser = async (user: string) => {
    // Since the service could be restarted since the user logged in, we'll make new connections
    if (dbByUser[user]) return dbByUser[user]
    dbByUser[user] = new Client({ database: userDbName(user) })
    await dbByUser[user].connect()
    await dbByUser[user].query(format('SET ROLE %L', user))
    return dbByUser[user]
  }

  const getUsernameFromSession = (sessid: string) => {
    try {
      if (!sessid) throw new Error('unauthenticated')
      const [encrypted, iv, tag] = sessid.split('-')
      const decipher = createDecipheriv('aes-256-gcm', config.sessionSalt, iv)
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return decipher.update(encrypted, 'base64', 'utf8') + decipher.final('utf8')
    } catch (e) {
      console.error(e)
      throw new Error('unauthenticated')
    }
  }

  const userDb = new Client({ database: 'postgres' })
  await userDb.connect()

  httpd.use(json({ limit: '1mb' }))

  httpd.post('/api/login', async (req, res, next) => {
    console.log(req.body)
    const { username: user, password } = req.body

    const database = userDbName(user)

    // Check if user exists as a PSQL user role
    const userRows = await userDb.query('SELECT usename FROM pg_user WHERE usename=$1', [user])
    if (userRows.rowCount === 1) {
      try {
        // try logging in as this user in postgresql
        dbByUser[user] = new Client({ database, user, password })
        await dbByUser[user].connect()
      } catch (err) {
        console.log(err)
        const unauthorized = new Error('Unauthorized')
        unauthorized.status = 401
        return next(unauthorized)
      }
    } else {
      console.log('New user ${user}')
      // Sign up a psql user
      await userDb.query(format('CREATE USER %I WITH ENCRYPTED PASSWORD %L', user, password))
      await userDb.query(format('GRANT %I TO %I', user, process.env.PGUSER))
      await userDb.query(format('CREATE DATABASE %I OWNER %I', database, user))
      //await userDb.query(format('GRANT ALL ON DATABASE %I TO %I', database, user))
      dbByUser[user] = new Client({ database, user, password })
      await dbByUser[user].connect()
    }

    const sessid =
      cipher.update(user, 'utf8', 'base64') +
      cipher.final('base64') +
      `-${iv}-${cipher.getAuthTag().toString('base64')}`

    res.status = 201
    console.log({ sessid })
    res.end(JSON.stringify({ sessid }))
  })

  httpd.post('/api/sync/:recordType', async (req, res, next) => {
    const { recordType } = req.params
    const { userid: sessid, data } = req.body
    if (!data?.length) return res.end('{"success":true}')

    if (!(recordType in recordTypes)) throw new Error('NOT IMPLEMENTED')

    const username = getUsernameFromSession(sessid)
    const database = userDbName(username)
    const db = await getDbForUser(username)

    const tableExists = await db.query(
      `SELECT 1 FROM information_schema.tables
         WHERE table_catalog = '${database}' AND table_name = '${recordType}'`,
    )

    console.log(tableExists)

    if (tableExists.rowCount === 0) {
      console.log(`CREATE TABLE "${recordType}" (
        id        VARCHAR PRIMARY KEY,
        metadata  JSONB,
        app       VARCHAR,
        time      TIMESTAMP,
        "startTime" TIMESTAMP,
        "endTime"   TIMESTAMP,
        ${Object.entries(recordTypes[recordType].fields).map(([k,v]) => `"${k}" ${v}`).join(' , ')}
      )`)

      console.log(data[0])
      throw new Error('stop')


      await db.query(`CREATE TABLE "${recordType}" (
        id        VARCHAR PRIMARY KEY,
        metadata  JSONB,
        app       VARCHAR,
        time      TIMESTAMP,
        "startTime" TIMESTAMP,
        "endTime"   TIMESTAMP,
        ${Object.entries(recordTypes[recordType].fields).map(([k,v]) => `"${k}" ${v}`).join(' , ')}
      )`)
    }

    throw new Error('stop')

    console.log(recordType, req.body)

    for (const item of data) {
      console.log(item)
      const id = item.metadata.id
      const { metadata, time, startTime, endTime, ...dataObj } = item
      const dataTuples = Object.entries({ id, metadata, time, startTime, endTime, data: dataObj }).filter(
        ([k, v]) => !!v,
      )
      console.log(`
        INSERT INTO "${recordType}"
          (${dataTuples.map(([k]) => `"${k}"`).join(',')})
         VALUES(${dataTuples
           .map(([, v]) => v)
           .map(formatValue)
           .join(',')})
         ON CONFLICT (id) DO UPDATE SET
           ${dataTuples
             .filter(([k]) => k !== 'id')
             .map(([k, v]) => `"${k}" = ${formatValue(v)}`)
             .join(' , ')}
        `)
      await db.query(`
        INSERT INTO "${recordType}"
          (${dataTuples.map(([k]) => `"${k}"`).join(',')})
         VALUES(${dataTuples
           .map(([, v]) => v)
           .map(formatValue)
           .join(',')})
         ON CONFLICT (id) DO UPDATE SET
           ${dataTuples
             .filter(([k]) => k !== 'id')
             .map(([k, v]) => `"${k}" = ${formatValue(v)}`)
             .join(' , ')}
        `)
    }

    res.end('{"success":true}')
  })

  httpd.listen(80, () => {
    console.log(`> Running on localhost:80`)
  })
}

main()
