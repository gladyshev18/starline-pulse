import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())
}

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  login: text('login').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  telegramChatId: text('telegram_chat_id'),
  createdAt: timestamps.createdAt
}, table => [uniqueIndex('users_login_unique').on(table.login)])

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['starline:poll', 'starline:close_trip', 'telegram:notify'] }).notNull(),
  payload: text('payload').notNull().default('{}'),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  lastError: text('last_error'),
  ...timestamps
}, table => [index('jobs_ready_idx').on(table.status, table.runAt)])

export const starlineTokens = sqliteTable('starline_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['app_code', 'app_token', 'user_token', 'slnet'] }).notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  updatedAt: timestamps.updatedAt
}, table => [uniqueIndex('starline_tokens_kind_unique').on(table.kind)])

export const apiCalls = sqliteTable('api_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  day: text('day').notNull(),
  endpoint: text('endpoint').notNull(),
  status: integer('status').notNull(),
  createdAt: timestamps.createdAt
}, table => [index('api_calls_day_idx').on(table.day)])

export const vehicles = sqliteTable('vehicles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: text('device_id').notNull(),
  alias: text('alias').notNull().default('Chery'),
  createdAt: timestamps.createdAt
}, table => [uniqueIndex('vehicles_device_id_unique').on(table.deviceId)])

export const vehicleSnapshots = sqliteTable('vehicle_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
  activityTs: integer('activity_ts', { mode: 'timestamp_ms' }),
  ignition: integer('ignition', { mode: 'boolean' }),
  mileage: real('mileage'),
  fuel: real('fuel'),
  battery: real('battery'),
  engineTemp: real('engine_temp'),
  cabinTemp: real('cabin_temp'),
  lat: real('lat'),
  lon: real('lon'),
  gsmLevel: integer('gsm_level'),
  rawJson: text('raw_json').notNull()
}, table => [index('snapshots_vehicle_ts_idx').on(table.vehicleId, table.ts)])

export const trips = sqliteTable('trips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  mileageStart: real('mileage_start'),
  mileageEnd: real('mileage_end'),
  distance: real('distance'),
  fuelStart: real('fuel_start'),
  fuelEnd: real('fuel_end'),
  fuelUsed: real('fuel_used'),
  latStart: real('lat_start'),
  lonStart: real('lon_start'),
  latEnd: real('lat_end'),
  lonEnd: real('lon_end'),
  isOpen: integer('is_open', { mode: 'boolean' }).notNull().default(true)
}, table => [index('trips_vehicle_started_idx').on(table.vehicleId, table.startedAt)])

export type Job = typeof jobs.$inferSelect
export type VehicleSnapshot = typeof vehicleSnapshots.$inferSelect
