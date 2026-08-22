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

export const telegramRecipients = sqliteTable('telegram_recipients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull(),
  chatId: text('chat_id').notNull(),
  firstName: text('first_name'),
  ...timestamps
}, table => [
  uniqueIndex('telegram_recipients_username_unique').on(table.username),
  uniqueIndex('telegram_recipients_chat_id_unique').on(table.chatId)
])

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['starline:poll', 'starline:close_trip', 'telegram:notify', 'telegram:report', 'telegram:fuel_reminder', 'receipts:imap_poll', 'service:parse_act'] }).notNull(),
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
  alias: text('alias').notNull().default('Автомобиль'),
  createdAt: timestamps.createdAt
}, table => [uniqueIndex('vehicles_device_id_unique').on(table.deviceId)])

export const vehicleSnapshots = sqliteTable('vehicle_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
  activityTs: integer('activity_ts', { mode: 'timestamp_ms' }),
  online: integer('online', { mode: 'boolean' }),
  ignition: integer('ignition', { mode: 'boolean' }),
  // Armed with the engine running can only mean a warm-up: an armed car cannot
  // be driven. It is the one exact way to catch the warm-up that ends in a trip,
  // because a remote start leaves the alarm on until the driver walks out.
  armed: integer('armed', { mode: 'boolean' }),
  mileage: real('mileage'),
  mileageTs: integer('mileage_ts', { mode: 'timestamp_ms' }),
  fuel: real('fuel'),
  fuelPercent: real('fuel_percent'),
  fuelTs: integer('fuel_ts', { mode: 'timestamp_ms' }),
  fuelSource: text('fuel_source', { enum: ['litres', 'percent', 'converted'] }),
  battery: real('battery'),
  batteryType: text('battery_type', { enum: ['percent', 'volt'] }),
  commonTs: integer('common_ts', { mode: 'timestamp_ms' }),
  engineTemp: real('engine_temp'),
  cabinTemp: real('cabin_temp'),
  lat: real('lat'),
  lon: real('lon'),
  positionTs: integer('position_ts', { mode: 'timestamp_ms' }),
  gsmLevel: integer('gsm_level'),
  // The alarm's own engine-hour counter, in minutes. Unlike anything derived
  // from polling it cannot miss a start, so it is the ground truth for how long
  // the engine actually ran — and the clock oil ages by.
  motorMinutes: integer('motor_minutes'),
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
  // Минуты внутри поездки, когда двигатель работал на охране. На охране ехать
  // нельзя, значит это прогрев, и средняя скорость считается без них — иначе
  // автозапуск за десять минут до выезда превращает трассу в город.
  armedMinutes: real('armed_minutes'),
  comment: text('comment'),
  // Имя того, кто вёл: бот спрашивает об этом сразу после завершения поездки.
  driver: text('driver'),
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
  // Not the time spent warming up: the odometer reports in chunks of ten to
  // twenty kilometres every ten minutes or so, so the first reported increase
  // says when the OBD next spoke, not when the car pulled away. Whether a
  // session was a warm-up is decided by the coolant temperature below.
  warmupMinutes: real('warmup_minutes'),
  engineTempStart: real('engine_temp_start'),
  engineTempEnd: real('engine_temp_end'),
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
  // The best known volume: what the sensor saw until a receipt corrects it. The
  // raw reading stays in sensor_litres_added so the drift remains visible and the
  // correction can be undone when the receipt is unlinked.
  litresAdded: real('litres_added'),
  sensorLitresAdded: real('sensor_litres_added'),
  percentBefore: real('percent_before'),
  percentAfter: real('percent_after'),
  lat: real('lat'),
  lon: real('lon'),
  station: text('station', { enum: ['rosneft', 'lukoil', 'other'] }),
  stationName: text('station_name'),
  fuelType: text('fuel_type'),
  pricePerLitre: real('price_per_litre'),
  totalAmount: real('total_amount')
}, table => [
  index('refuel_events_vehicle_detected_idx').on(table.vehicleId, table.detectedAt),
  uniqueIndex('refuel_events_vehicle_detected_unique').on(table.vehicleId, table.detectedAt)
])

// A receipt lives on its own: an email or a photo can arrive before — or without —
// the fuel level jump that creates a refuel event, so both the linked event and
// the stored file are optional. Receipt figures are kept apart from the ones on
// refuel_events so a discrepancy between the sensor and the paper stays visible.
export const refuelReceipts = sqliteTable('refuel_receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  refuelEventId: integer('refuel_event_id').references(() => refuelEvents.id),
  suggestedRefuelEventId: integer('suggested_refuel_event_id').references(() => refuelEvents.id),
  source: text('source', { enum: ['manual', 'imap', 'telegram'] }).notNull().default('manual'),
  dataSource: text('data_source', { enum: ['manual', 'parsed', 'qr'] }).notNull().default('manual'),
  matchStatus: text('match_status', { enum: ['unmatched', 'suggested', 'auto', 'manual', 'rejected'] }).notNull().default('unmatched'),
  matchScore: real('match_score'),
  matchedAt: integer('matched_at', { mode: 'timestamp_ms' }),
  paymentMethod: text('payment_method', { enum: ['card', 'cash', 'unknown'] }).notNull().default('unknown'),
  purchasedAt: integer('purchased_at', { mode: 'timestamp_ms' }),
  station: text('station', { enum: ['rosneft', 'lukoil', 'other'] }),
  stationName: text('station_name'),
  address: text('address'),
  fuelType: text('fuel_type'),
  litres: real('litres'),
  pricePerLitre: real('price_per_litre'),
  totalAmount: real('total_amount'),
  fiscalDocNumber: text('fiscal_doc_number'),
  fiscalSign: text('fiscal_sign'),
  sellerInn: text('seller_inn'),
  originalName: text('original_name'),
  storedName: text('stored_name'),
  mimeType: text('mime_type'),
  size: integer('size'),
  contentHash: text('content_hash'),
  externalMessageId: text('external_message_id'),
  // Telegram asks for a missing figure in the next message; the awaited field is
  // stored here because the worker restarts and would lose in-memory dialog state.
  pendingField: text('pending_field', { enum: ['litres', 'totalAmount', 'pricePerLitre'] }),
  pendingChatId: text('pending_chat_id'),
  ...timestamps
}, table => [
  index('refuel_receipts_refuel_event_idx').on(table.refuelEventId),
  index('refuel_receipts_match_status_idx').on(table.matchStatus),
  index('refuel_receipts_purchased_at_idx').on(table.purchasedAt),
  index('refuel_receipts_content_hash_idx').on(table.contentHash),
  uniqueIndex('refuel_receipts_stored_name_unique').on(table.storedName),
  uniqueIndex('refuel_receipts_external_message_id_unique').on(table.externalMessageId)
])

// Oil ages on three clocks at once — distance, engine time and the calendar —
// and only the first two are in the car. Recording what the odometer and the
// engine-hour counter read at the moment of service is what makes a countdown
// possible at all; without it neither number means anything on its own.
export const serviceEvents = sqliteTable('service_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vehicleId: integer('vehicle_id').notNull().references(() => vehicles.id),
  kind: text('kind', { enum: ['oil'] }).notNull().default('oil'),
  performedAt: integer('performed_at', { mode: 'timestamp_ms' }).notNull(),
  mileage: real('mileage'),
  motorMinutes: integer('motor_minutes'),
  note: text('note'),
  ...timestamps
}, table => [index('service_events_vehicle_kind_idx').on(table.vehicleId, table.kind, table.performedAt)])

// A photo sent to the bot is either a fuel receipt or a service act, and until
// the act parser exists nothing in the picture says which. So the file is stored
// first and classified after: an unanswered document stays `unknown` rather than
// being guessed into the wrong pile, and the parsed columns wait empty for the
// parser that will fill them.
export const serviceDocuments = sqliteTable('service_documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceEventId: integer('service_event_id').references(() => serviceEvents.id),
  kind: text('kind', { enum: ['unknown', 'act'] }).notNull().default('unknown'),
  source: text('source', { enum: ['telegram', 'manual'] }).notNull().default('telegram'),
  receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
  performedAt: integer('performed_at', { mode: 'timestamp_ms' }),
  vendor: text('vendor'),
  totalAmount: real('total_amount'),
  mileage: real('mileage'),
  note: text('note'),
  orderNumber: text('order_number'),
  // Null while the document has only been stored; set when a parser has read it.
  parsedAt: integer('parsed_at', { mode: 'timestamp_ms' }),
  // What OCR made of each field and how many passes agreed, so the form can show
  // which values were read confidently and which are a single shaky guess.
  parsedJson: text('parsed_json'),
  originalName: text('original_name'),
  storedName: text('stored_name'),
  mimeType: text('mime_type'),
  size: integer('size'),
  contentHash: text('content_hash'),
  pendingChatId: text('pending_chat_id'),
  ...timestamps
}, table => [
  index('service_documents_kind_idx').on(table.kind, table.receivedAt),
  index('service_documents_content_hash_idx').on(table.contentHash),
  uniqueIndex('service_documents_stored_name_unique').on(table.storedName)
])

export const imapState = sqliteTable('imap_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mailbox: text('mailbox').notNull(),
  uidValidity: text('uid_validity'),
  lastUid: integer('last_uid').notNull().default(0),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  ...timestamps
}, table => [uniqueIndex('imap_state_mailbox_unique').on(table.mailbox)])

export type Job = typeof jobs.$inferSelect
export type VehicleSnapshot = typeof vehicleSnapshots.$inferSelect
export type RefuelEvent = typeof refuelEvents.$inferSelect
export type RefuelReceipt = typeof refuelReceipts.$inferSelect
export type ServiceEvent = typeof serviceEvents.$inferSelect
export type ServiceDocument = typeof serviceDocuments.$inferSelect
