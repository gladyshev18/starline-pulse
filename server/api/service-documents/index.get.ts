import { listServiceDocuments } from '../../../receipts/service-documents'

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  return { items: await listServiceDocuments(database) }
})
