import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const WA_API_URL = process.env.WA_API_URL;
const WA_API_KEY = process.env.WA_API_KEY;

// Rota de teste para verificar se o microserviço está online
app.get('/', (req, res) => {
  res.json({ status: 'Microserviço de WhatsApp operacional via Gateway Externo' });
});

// Rota principal para receber pedidos de envio da API do site
app.post('/enviar', async (req, res) => {
  const { jid, mensagem } = req.body;
  
  if (!WA_API_URL) {
    return res.status(500).json({ error: 'WA_API_URL não configurada nas variáveis de ambiente.' });
  }

  try {
    // Formata o número a partir do JID (remove o sufixo do WhatsApp)
    const phone = jid ? jid.replace('@s.whatsapp.net', '').replace('@g.us', '') : '';

    // Disparo para a API externa configurada (ex: Z-API)
    const response = await fetch(WA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WA_API_KEY ? { 'Client-Token': WA_API_KEY } : {})
      },
      body: JSON.stringify({
        phone: phone,
        message: mensagem
      })
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Erro ao enviar mensagem pela API externa.');
    }

    return res.json({ sucesso: true, resultado: data });
  } catch (error) {
    console.error('[Erro no envio de WhatsApp]:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Microserviço do WhatsApp a rodar na porta ${PORT}`);
});
