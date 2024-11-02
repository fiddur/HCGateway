import { json } from 'body-parser'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { Client } from 'pg'
import format from 'pg-format'
import polka from 'polka'
import {
  ActiveCaloriesBurnedRecord,
  BasalMetabolicRateRecord,
  BodyFatRecord,
  BoneMassRecord,
  DistanceRecord,
  HealthConnectRecordResult,
} from 'react-native-health-connect'
import {
  EnergyResult,
  InstantaneousRecord,
  IntervalRecord,
  LengthResult,
  MassResult,
} from 'react-native-health-connect/lib/typescript/types/base.types'

// Since react-native-health-connect doesn't export the result types, we need to recreate them :(
type Identity<T> = { [P in keyof T]: T[P] }
type Replace<T, K extends keyof T, TReplace> = Identity<
  Pick<T, Exclude<keyof T, K>> & {
    [P in K]: TReplace
  }
>

const camelToSnakeCase = (str: string) =>
  str[0].toLowerCase() + str.slice(1, str.length).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

const query = async (db: Client, queryStr: string, params?: any[]) => {
  console.log(`>>>`, queryStr, params)
  const result = await db.query(queryStr, params)
  console.log('<<<', result.rows)
  return result
}

const energyType = {
  inCalories: 'FLOAT8',
  inJoules: 'FLOAT8',
  inKilocalories: 'FLOAT8',
  inKilojoules: 'FLOAT8',
}
const energyTranform = (energy: EnergyResult) => ({
  inCalories: energy.inCalories,
  inJoules: energy.inJoules,
  inKilocalories: energy.inKilocalories,
  inKilojoules: energy.inKilojoules,
})
const intervalType = { endTime: 'TIMESTAMP', startTime: 'TIMESTAMP' }
const intervalTransform = (item: IntervalRecord) => ({ endTime: item.endTime, startTime: item.startTime })
const instantType = { time: 'TIMESTAMP' }
const instantTransform = (item: InstantaneousRecord) => ({ time: item.time })
const lengthType = {
  inMeters: 'FLOAT8',
  inKilometers: 'FLOAT8',
  inMiles: 'FLOAT8',
  inInches: 'FLOAT8',
  inFeet: 'FLOAT8',
}
const lengthTransform = (length: LengthResult) => ({
  inMeters: length.inMeters,
  inKilometers: length.inKilometers,
  inMiles: length.inMiles,
  inInches: length.inInches,
  inFeet: length.inFeet,
})
const massType = {
  inGrams: 'FLOAT8',
  inKilograms: 'FLOAT8',
  inMilligrams: 'FLOAT8',
  inMicrograms: 'FLOAT8',
  inOunces: 'FLOAT8',
  inPounds: 'FLOAT8',
}
const massTransform = (mass: MassResult) => ({
  inGrams: mass.inGrams,
  inKilograms: mass.inKilograms,
  inMilligrams: mass.inMilligrams,
  inMicrograms: mass.inMicrograms,
  inOunces: mass.inOunces,
  inPounds: mass.inPounds,
})
const recordTypes = {
  ActiveCaloriesBurned: {
    fields: { ...intervalType, ...energyType },
    transform: (item: Replace<ActiveCaloriesBurnedRecord, 'energy', EnergyResult>) => ({
      ...intervalTransform(item),
      ...energyTranform(item.energy),
    }),
  },
  //   'BasalBodyTemperature',
  //   'BloodGlucose',
  //   'BloodPressure',
  BasalMetabolicRate: {
    fields: {
      ...instantType,
      inKilocaloriesPerDay: 'FLOAT8',
      inWatts: 'FLOAT8',
    },
    transform: (
      item: Replace<
        BasalMetabolicRateRecord,
        'basalMetabolicRate',
        {
          inKilocaloriesPerDay: number
          inWatts: number
        }
      >,
    ) => ({
      inKilocaloriesPerDay: item.basalMetabolicRate.inKilocaloriesPerDay,
      inWatts: item.basalMetabolicRate.inWatts,
      ...instantTransform(item),
    }),
  },
  BodyFat: {
    fields: { ...instantType, percentage: 'FLOAT8' },
    transform: (item: BodyFatRecord) => ({ percentage: item.percentage, time: item.time }),
  },
  //   'BodyTemperature',
  BoneMass: {
    fields: { ...instantType, ...massType },
    transform: (item: Replace<BoneMassRecord, 'mass', MassResult>) => ({
      ...instantTransform(item),
      ...massTransform(item.mass),
    }),
  },
  //   'CyclingPedalingCadence',
  //   'CervicalMucus',
  //   'ExerciseSession',
  Distance: {
    fields: { ...intervalType, ...lengthType },
    transform: (item: Replace<DistanceRecord, 'distance', LengthResult>) => ({
      ...intervalTransform(item),
      ...lengthTransform(item.distance),
    }),
  },
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
    await query(dbByUser[user], format('SET ROLE %L', user))
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
    const userRows = await query(userDb, 'SELECT usename FROM pg_user WHERE usename=$1', [user])
    if (userRows.rowCount === 1) {
      try {
        // try logging in as this user in postgresql
        dbByUser[user] = new Client({ database, password, user })
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
      await query(userDb, format('CREATE USER %I WITH ENCRYPTED PASSWORD %L', user, password))
      await query(userDb, format('GRANT %I TO %I', user, process.env.PGUSER))
      await query(userDb, format('CREATE DATABASE %I OWNER %I', database, user))
      dbByUser[user] = new Client({ database, password, user })
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

  httpd.post('/api/sync/:recordType', async (req, res) => {
    const { recordType } = req.params
    const { userid: sessid, data } = req.body
    if (!data?.length) return res.end('{"success":true}')

    if (!(recordType in recordTypes)) {
      console.warn(recordType, data[0])
      throw new Error(`NOT IMPLEMENTED: ${recordType}`)
    }

    const username = getUsernameFromSession(sessid)
    const database = userDbName(username)
    const db = await getDbForUser(username)

    const tableExists = await query(
      db,
      `SELECT 1 FROM information_schema.tables WHERE table_catalog = $1 AND table_name = $2`,
      [database, camelToSnakeCase(recordType)],
    )

    console.log(tableExists)

    if (tableExists.rowCount === 0) {
      await query(
        db,
        `CREATE TABLE "${camelToSnakeCase(recordType)}" (
        id        VARCHAR PRIMARY KEY,
        metadata  JSONB,
        app       VARCHAR,
        ${Object.entries(recordTypes[recordType].fields)
          .map(([k, v]) => `"${k}" ${v}`)
          .join(' , ')}
      )`,
      )
    }

    for (const item of data as HealthConnectRecordResult[]) {
      console.log(`Handling ${recordType} item`, item)

      const result = {
        app: item.metadata.dataOrigin,
        id: item.metadata.id,
        metadata: JSON.stringify(item.metadata),
        ...recordTypes[recordType].transform(item),
      }
      const tuples = Object.entries(result)

      await query(
        db,
        `
        INSERT INTO "${camelToSnakeCase(recordType)}"
          (${tuples.map(([k]) => `"${k}"`).join(',')})
         VALUES(${tuples
           .map(([, v]) => v)
           .map(formatValue)
           .join(',')})
         ON CONFLICT (id) DO UPDATE SET
           ${tuples
             .filter(([k]) => k !== 'id')
             .map(([k, v]) => `"${k}" = ${formatValue(v)}`)
             .join(' , ')}
        `,
      )
    }

    res.end('{"success":true}')
  })

  httpd.listen(8008, () => {
    console.log(`> Running on localhost:8008`)
  })
}

main()
