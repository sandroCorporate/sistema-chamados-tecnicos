import { neon } from '@neondatabase/serverless';

const connectionString = 'postgresql://neondb_owner:npg_ystoQzBV8m3x@ep-proud-rice-b6pabqxw.c-2.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

console.log("A testar ligação com a string:", connectionString.substring(0, 45) + "...");

const sql = neon(connectionString);

export default {
  query: async (text, params) => {
    try {
      const result = await sql(text, params);
      const rows = Array.isArray(result) ? result : (result?.rows || []);
      return { rows };
    } catch (err) {
      console.error("Erro detalhado no Neon DB:", err.message);
      throw err;
    }
  },
};