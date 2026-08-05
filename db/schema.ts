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
  kind: text('kind', { enum: ['app_code', 'app_token', 'user_token', 'slnet', 'slnet_user_id'] }).notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  updatedAt: timestamps.updatedAt
}, table => [uniqueIndex('starline_tokens_kind_unique').on(table.kind)])

export const apiCalls = sqliteTable('api_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  day: text('day').notNull(),
  endpoint: text('endpoint').notNull(),
  method: text('method').notNull().default('GET'),
  url: text('url'),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms'),
  requestHeaders: text('request_headers'),
  requestBody: text('request_body'),
  responseHeaders: text('response_headers'),
  responseBody: text('response_body'),
  error: text('error'),
  createdAt: timestamps.createdAt
}, table => [
  index('api_calls_day_idx').on(table.day),
  index('api_calls_created_at_idx').on(table.createdAt),
  index('api_calls_status_idx').on(table.status)
])

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
  online: integer('online', { mode: 'boolean' }),
  ignition: integer('ignition', { mode: 'boolean' }),
  mileage: real('mileage'),
  mileageTs: integer('mileage_ts', { mode: 'timestamp_ms' }),
  fuel: real('fuel'),
  fuelPercent: real('fuel_percent'),
  fuelTs: integer('fuel_ts', { mode: 'timestamp_ms' }),
  fuelSource: text('fuel_source', { enum: ['litres', 'converted'] }),
  battery: real('battery'),
  batteryType: text('battery_type', { enum: ['percent', 'volt'] }),
  commonTs: integer('common_ts', { mode: 'timestamp_ms' }),
  engineTemp: real('engine_temp'),
  cabinTemp: real('cabin_temp'),
  lat: real('lat'),
  lon: real('lon'),
  positionTs: integer('position_ts', { mode: 'timestamp_ms' }),
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

export const engineSessions = sqliteTable('engine_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  firstMovementAt: integer('first_movement_at', { mode: 'timestamp_ms' }),
  mileageStart: real('mileage_start'),
  mileageEnd: real('mileage_end'),
  fuelStart: real('fuel_start'),
  fuelEnd: real('fuel_end'),
  distance: real('distance'),
  durationMinutes: real('duration_minutes'),
  warmupMinutes: real('warmup_minutes'),
  isStationary: integer('is_stationary', { mode: 'boolean' }),
  isOpen: integer('is_open', { mode: 'boolean' }).notNull().default(true)
}, table => [index('engine_sessions_vehicle_started_idx').on(table.vehicleId, table.startedAt)])

export const refuelEvents = sqliteTable('refuel_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
  mileage: real('mileage'),
  fuelBefore: real('fuel_before'),
  fuelAfter: real('fuel_after'),
  litresAdded: real('litres_added'),
  percentBefore: real('percent_before'),
  percentAfter: real('percent_after'),
  lat: real('lat'),
  lon: real('lon')
}, table => [
  index('refuel_events_vehicle_detected_idx').on(table.vehicleId, table.detectedAt),
  uniqueIndex('refuel_events_vehicle_detected_unique').on(table.vehicleId, table.detectedAt)
])

export const refuelReceipts = sqliteTable('refuel_receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refuelEventId: integer('refuel_event_id').notNull().references(() => refuelEvents.id),
  source: text('source', { enum: ['manual', 'imap'] }).notNull().default('manual'),
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  externalMessageId: text('external_message_id'),
  createdAt: timestamps.createdAt
}, table => [
  index('refuel_receipts_refuel_event_idx').on(table.refuelEventId),
  uniqueIndex('refuel_receipts_stored_name_unique').on(table.storedName)
])

export type Job = typeof jobs.$inferSelect
export type VehicleSnapshot = typeof vehicleSnapshots.$inferSelect
