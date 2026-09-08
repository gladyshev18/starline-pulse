import { insights } from '../../../metrics/insights'

export default defineEventHandler(async () => insights(useAppDatabase()))
