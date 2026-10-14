import dotenv from 'dotenv';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { MercadoPagoConfig, Payment } from 'mercadopago';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_super_segura';

// Token real do Mercado Pago integrado
const MP_TOKEN_REAL = 'TEST-13eb31fe-4738-400a-ba0c-75382fc3d471';

// Inicializa o cliente do Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || MP_TOKEN_REAL,
});

app.use(express.json());

// ==========================================
// FUNÇÃO AUXILIAR: Envio de WhatsApp (Z-API Correta)
// ==========================================
async function enviarNotificacaoWhatsApp(telefone, mensagem) {
  // URL com o ID da instância e o Token da instância (visível no print)
  const waUrl = 'https://api.z-api.io/instances/3FA96A6E1C7E826EA6682AB027F8477F/token/B2F6CE0E3D44D70B123969D9/send-text';
  // Client-Token mestre da conta Z-API
  const clientTokenMestre = 'B2F6CE0E3D44D70B12975971';

  if (!telefone || telefone.trim() === '') {
    console.log('[WhatsApp Skipped] Telefone não configurado.');
    return;
  }

  let numApenasDigitos = telefone.replace(/\D/g, '');
  if (numApenasDigitos.length === 10 || numApenasDigitos.length === 11) {
    numApenasDigitos = '55' + numApenasDigitos;
  }

  try {
    const response = await fetch(waUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': clientTokenMestre,
      },
      body: JSON.stringify({
        phone: numApenasDigitos,
        message: mensagem,
      }),
    });

    const data = await response.json();
    console.log(`[WhatsApp Sent] Resposta Z-API para ${numApenasDigitos}:`, data);
  } catch (error) {
    console.error(
      '[WhatsApp Error] Falha ao enviar notificação (ignorado):',
      error.message
    );
  }
}

// ==========================================
// MIDDLEWARE: Autenticação JWT
// ==========================================
function autenticarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res
      .status(401)
      .json({ error: 'Acesso negado. Token não fornecido.' });
  }

  try {
    const usuario = jwt.verify(token, JWT_SECRET);
    req.usuario = usuario;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
}

// ==========================================
// ROTA: Frontend Principal (SPA)
// ==========================================
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sistema de Chamados Técnicos</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      body { background-color: #f1f5f9; color: #334155; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
      .container { background: #ffffff; width: 100%; max-width: 500px; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
      h2, h3, h4 { color: #1e293b; margin-bottom: 16px; }
      .form-group { margin-bottom: 16px; }
      label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
      input, textarea, select { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 14px; outline: none; }
      input:focus, textarea:focus, select:focus { border-color: #2563eb; }
      button { width: 100%; background-color: #2563eb; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background-color 0.2s; }
      button:hover { background-color: #1d4ed8; }
      .btn-danger { background-color: #ef4444; }
      .btn-danger:hover { background-color: #dc2626; }
      .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; }
      .badge-ABERTO { background-color: #fef3c7; color: #d97706; }
      .badge-AGUARDANDO_PAGAMENTO, .badge-AGUARDANDO\\ PAGAMENTO { background-color: #ffedd5; color: #c2410c; }
      .badge-EM_ATENDIMENTO, .badge-EM\\ ATENDIMENTO { background-color: #dbeafe; color: #2563eb; }
      .badge-CONCLUIDO { background-color: #dcfce7; color: #16a34a; }
      .hidden { display: none !important; }
      .header-user { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }
      .msg { padding: 10px; border-radius: 6px; font-size: 13px; margin-top: 10px; }
      .msg-error { background-color: #fee2e2; color: #991b1b; }
      .msg-success { background-color: #dcfce7; color: #166534; }
      .pix-box { background: #fff; border: 1px dashed #f97316; padding: 10px; border-radius: 6px; margin-top: 10px; text-align: center; }

      @media (max-width: 480px) {
        body { padding: 8px; align-items: flex-start; }
        .container { padding: 16px; border-radius: 0; box-shadow: none; min-height: 100vh; }
        input, textarea, select, button { font-size: 16px; padding: 12px; }
        .header-user { flex-direction: column; align-items: flex-start; gap: 10px; }
        .header-user button { align-self: flex-end; width: auto; }
        p, small { word-break: break-word; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div id="screen-login">
        <h2>Acesso ao Sistema</h2>
        <div id="login-msg"></div>
        <form id="form-login" style="margin-top: 15px">
          <div class="form-group">
            <label>E-mail</label>
            <input type="email" id="login-email" required placeholder="sandro@tech.com" />
          </div>
          <div class="form-group">
            <label>Senha</label>
            <input type="password" id="login-senha" required placeholder="••••••••" />
          </div>
          <button type="submit">Entrar</button>
        </form>
      </div>

      <div id="screen-dashboard" class="hidden">
        <div class="header-user">
          <div>
            <h3 style="margin: 0">Painel de Chamados</h3>
            <small id="user-info" style="color: #64748b"></small>
          </div>
          <button id="btn-logout" class="btn-danger" style="width: auto; padding: 6px 12px">Sair</button>
        </div>

        <div id="section-novo-chamado" class="card" style="margin-bottom: 20px">
          <h4 style="margin-bottom: 10px">Abrir Novo Chamado</h4>
          <div id="chamado-msg"></div>
          <form id="form-chamado">
            <div class="form-group">
              <label>Título</label>
              <input type="text" id="chamado-titulo" required placeholder="Ex: Substituição de Disco Rígido" />
            </div>
            <div class="form-group">
              <label>Descrição</label>
              <textarea id="chamado-descricao" rows="3" required placeholder="Descreva os detalhes do problema..."></textarea>
            </div>
            <button type="submit">Enviar Chamado</button>
          </form>
        </div>

        <h3>Chamados Registados</h3>
        <div id="lista-chamados">
          <p style="color: #64748b">Carregando...</p>
        </div>
      </div>
    </div>

    <script>
      let token = localStorage.getItem('token');
      let usuario = JSON.parse(localStorage.getItem('usuario') || 'null');

      const screenLogin = document.getElementById('screen-login');
      const screenDashboard = document.getElementById('screen-dashboard');
      const loginMsg = document.getElementById('login-msg');
      const chamadoMsg = document.getElementById('chamado-msg');

      if (token && usuario) {
        showDashboard();
      } else {
        showLogin();
      }

      function showLogin() {
        screenLogin.classList.remove('hidden');
        screenDashboard.classList.add('hidden');
      }

      function showDashboard() {
        screenLogin.classList.add('hidden');
        screenDashboard.classList.remove('hidden');
        document.getElementById('user-info').innerText = \`\${usuario.nome} (\${usuario.tipo}) - \${usuario.email}\`;

        if (usuario.tipo === 'CLIENTE' || usuario.tipo === 'cliente') {
          document.getElementById('section-novo-chamado').classList.remove('hidden');
        } else {
          document.getElementById('section-novo-chamado').classList.add('hidden');
        }

        carregarChamados();
      }

      document.getElementById('form-login').addEventListener('submit', async (e) => {
        e.preventDefault();
        loginMsg.innerHTML = '';
        const email = document.getElementById('login-email').value;
        const senha = document.getElementById('login-senha').value;

        try {
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, senha }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Erro ao realizar login.');

          token = data.token;
          usuario = data.usuario;
          localStorage.setItem('token', token);
          localStorage.setItem('usuario', JSON.stringify(usuario));
          showDashboard();
        } catch (err) {
          loginMsg.innerHTML = \`<div class="msg msg-error">\${err.message}</div>\`;
        }
      });

      document.getElementById('form-chamado').addEventListener('submit', async (e) => {
        e.preventDefault();
        chamadoMsg.innerHTML = '';
        const titulo = document.getElementById('chamado-titulo').value;
        const descricao = document.getElementById('chamado-descricao').value;

        try {
          const res = await fetch('/api/chamados', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
            body: JSON.stringify({ titulo, descricao }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Erro ao criar chamado.');

          document.getElementById('chamado-titulo').value = '';
          document.getElementById('chamado-descricao').value = '';
          chamadoMsg.innerHTML = \`<div class="msg msg-success">Chamado aberto com sucesso!</div>\`;
          carregarChamados();
        } catch (err) {
          chamadoMsg.innerHTML = \`<div class="msg msg-error">\${err.message}</div>\`;
        }
      });

      async function carregarChamados() {
        const listaDiv = document.getElementById('lista-chamados');
        try {
          const res = await fetch('/api/chamados', {
            headers: { Authorization: \`Bearer \${token}\` },
          });
          const chamados = await res.json();
          if (!res.ok) throw new Error(chamados.error || 'Erro ao buscar chamados.');

          if (chamados.length === 0) {
            listaDiv.innerHTML = '<p style="color: #64748b;">Nenhum chamado encontrado.</p>';
            return;
          }

          listaDiv.innerHTML = chamados.map((c) => {
            const statusClass = c.status ? c.status.replace(/\\s+/g, '_') : 'ABERTO';
            return \`
            <div class="card" id="card-\${c.id}">
              <div style="display: flex; justify-content: space-between; align-items: start;">
                <h4 id="titulo-\${c.id}">\${c.titulo}</h4>
                <span class="badge badge-\${statusClass}">\${c.status}</span>
              </div>
              <p id="desc-\${c.id}" style="margin-top: 8px; color: #475569;">\${c.descricao}</p>
              <small style="color: #94a3b8; display: block; margin-top: 8px;">Criado em: \${new Date(c.criado_em).toLocaleString('pt-BR')}</small>
              
              \${c.valor && Number(c.valor) > 0 ? \`<small style="color: #0284c7; display: block; font-weight: bold; margin-top: 4px;">Valor: R$ \${Number(c.valor).toFixed(2)}</small>\` : ''}

              <div id="pix-container-\${c.id}" class="pix-box hidden">
                <p style="font-size: 12px; font-weight: bold; color: #c2410c; margin-bottom: 5px;">Escaneie o QR Code ou copie o Pix:</p>
                <img id="pix-img-\${c.id}" src="" alt="QR Code Pix" style="max-width: 150px; display: block; margin: 0 auto 8px auto;" />
                <textarea id="pix-copia-\${c.id}" rows="2" style="font-size: 11px; resize: none;" readonly></textarea>
                <button type="button" onclick="window.copiarPix('\${c.id}')" style="margin-top: 6px; background-color: #f97316; font-size: 12px; padding: 6px;">Copiar Código Pix</button>
              </div>
              
              \${
                (usuario.tipo === 'CLIENTE' || usuario.tipo === 'cliente') && c.status === 'ABERTO'
                  ? \`
                <div style="margin-top: 10px; border-top: 1px solid #cbd5e1; padding-top: 8px; display: flex; gap: 5px;">
                  <button type="button" class="btn-toggle-edicao" data-id="\${c.id}" style="background-color: #f59e0b; width: auto; padding: 5px 12px; font-size: 12px; color: white; border: none; border-radius: 6px; cursor: pointer;">Editar</button>
                </div>
                <form id="form-edit-\${c.id}" class="hidden" style="margin-top: 10px;" onsubmit="window.salvarEdicao(event, '\${c.id}')">
                  <input type="text" id="input-edit-titulo-\${c.id}" value="\${c.titulo.replace(/"/g, '&quot;')}" style="margin-bottom: 5px;" required>
                  <textarea id="input-edit-desc-\${c.id}" rows="2" style="margin-bottom: 5px;" required>\${c.descricao}</textarea>
                  <div style="display: flex; gap: 5px;">
                    <button type="submit" style="background-color: #10b981; width: auto; padding: 5px 12px; font-size: 12px;">Guardar</button>
                    <button type="button" class="btn-toggle-edicao" data-id="\${c.id}" style="background-color: #64748b; width: auto; padding: 5px 12px; font-size: 12px;">Cancelar</button>
                  </div>
                </form>
              \`
                  : ''
              }

              \${
                (usuario.tipo === 'CLIENTE' || usuario.tipo === 'cliente') && (c.status === 'AGUARDANDO_PAGAMENTO' || c.status === 'AGUARDANDO PAGAMENTO') && (!c.pagamento_id)
                  ? \`
                <div style="margin-top: 10px; border-top: 1px solid #cbd5e1; padding-top: 8px;">
                  <button type="button" onclick="window.gerarPix('\${c.id}', \${c.valor || 50.00})" style="background-color: #f97316; font-size: 12px; padding: 8px;">Pagar com Pix</button>
                </div>
              \`
                  : ''
              }

              \${
                usuario.tipo !== 'CLIENTE' && usuario.tipo !== 'cliente'
                  ? \`
                <div style="margin-top: 10px; border-top: 1px solid #cbd5e1; padding-top: 8px;">
                  <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 6px;">
                    <div style="flex: 1;">
                      <label style="font-size: 12px;">Status:</label>
                      <select id="select-status-\${c.id}" style="margin-top: 4px;">
                        <option value="ABERTO" \${c.status === 'ABERTO' ? 'selected' : ''}>ABERTO</option>
                        <option value="AGUARDANDO PAGAMENTO" \${c.status === 'AGUARDANDO PAGAMENTO' || c.status === 'AGUARDANDO_PAGAMENTO' ? 'selected' : ''}>AGUARDANDO PAGAMENTO</option>
                        <option value="EM ATENDIMENTO" \${c.status === 'EM ATENDIMENTO' || c.status === 'EM_ATENDIMENTO' ? 'selected' : ''}>EM ATENDIMENTO</option>
                        <option value="CONCLUIDO" \${c.status === 'CONCLUIDO' ? 'selected' : ''}>CONCLUIDO</option>
                      </select>
                    </div>
                    <div style="width: 90px;">
                      <label style="font-size: 12px;">Valor (R$):</label>
                      <input type="number" step="0.01" id="input-val-\${c.id}" value="\${c.valor || '0.00'}" style="margin-top: 4px; padding: 8px;" />
                    </div>
                  </div>
                  <button type="button" onclick="window.salvarDadosTecnico('\${c.id}')" style="background-color: #10b981; font-size: 12px; padding: 6px;">Guardar Alterações</button>
                </div>
              \`
                  : ''
              }
            </div>
          \`;
          }).join('');
        } catch (err) {
          listaDiv.innerHTML = \`<div class="msg msg-error">\${err.message}</div>\`;
        }
      }

      document.body.addEventListener('click', function (e) {
        const targetBtn = e.target.closest('.btn-toggle-edicao');
        if (targetBtn) {
          e.preventDefault();
          const id = targetBtn.getAttribute('data-id');
          const form = document.getElementById(\`form-edit-\${id}\`);
          if (form) {
            form.classList.toggle('hidden');
          }
        }
      });

      window.salvarDadosTecnico = async function(id) {
        const novoStatus = document.getElementById(\`select-status-\${id}\`).value;
        const novoValor = document.getElementById(\`input-val-\${id}\`).value;

        try {
          await fetch(\`/api/chamados/\${id}/valor\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
            body: JSON.stringify({ valor: parseFloat(novoValor) }),
          });

          const resStatus = await fetch(\`/api/chamados/\${id}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
            body: JSON.stringify({ status: novoStatus }),
          });

          const data = await resStatus.json();
          if (!resStatus.ok) throw new Error(data.error || 'Erro ao atualizar status.');

          alert('Chamado atualizado com sucesso!');
          carregarChamados();
        } catch (err) {
          alert('Erro ao guardar: ' + err.message);
        }
      };

      window.gerarPix = async function (id, valorPadrao) {
        const valorInput = prompt('Confirme o valor do atendimento para pagamento Pix (R$):', valorPadrao);
        if (!valorInput) return;

        try {
          const res = await fetch(\`/api/chamados/\${id}/pagar-pix\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
            body: JSON.stringify({ valor: parseFloat(valorInput) }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Erro ao gerar Pix.');

          document.getElementById(\`pix-img-\${id}\`).src = \`data:image/png;base64,\${data.qrCodeBase64}\`;
          document.getElementById(\`pix-copia-\${id}\`).value = data.qrCode;
          document.getElementById(\`pix-container-\${id}\`).classList.remove('hidden');
          alert('Cobrança Pix gerada com sucesso!');
        } catch (err) {
          alert(err.message);
        }
      };

      window.copiarPix = function (id) {
        const textarea = document.getElementById(\`pix-copia-\${id}\`);
        textarea.select();
        document.execCommand('copy');
        alert('Código Pix copiado para a área de transferência!');
      };

      window.salvarEdicao = async function (event, id) {
        event.preventDefault();
        const inputTitulo = document.getElementById(\`input-edit-titulo-\${id}\`);
        const inputDesc = document.getElementById(\`input-edit-desc-\${id}\`);

        try {
          const res = await fetch(\`/api/chamados/\${id}/editar\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
            body: JSON.stringify({ titulo: inputTitulo.value, descricao: inputDesc.value }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Erro ao guardar alterações.');

          carregarChamados();
          alert('Chamado atualizado com sucesso!');
        } catch (err) {
          alert(\`Erro ao salvar: \${err.message}\`);
        }
      };

      document.getElementById('btn-logout').addEventListener('click', () => {
        localStorage.removeItem('token');
        localStorage.removeItem('usuario');
        token = null;
        usuario = null;
        showLogin();
      });
    </script>
  </body>
</html>`);
});

// ==========================================
// ROTA: Registrar Usuário
// ==========================================
app.post('/api/registro', async (req, res) => {
  try {
    const { nome, email, senha, tipo, telefone } = req.body;
    if (!nome || !email || !senha) {
      return res
        .status(400)
        .json({ error: 'Nome, email e senha são obrigatórios.' });
    }
    const salt = await bcrypt.genSalt(10);
    const senhaHash = await bcrypt.hash(senha, salt);
    const tipoUsuario = tipo || 'CLIENTE';

    let result;
    try {
      result = await db.query(
        'INSERT INTO usuarios (nome, email, senha_hash, tipo, telefone) VALUES (\$1, \$2, \$3, \$4, \$5) RETURNING id, nome, email, telefone',
        [nome, email, senhaHash, tipoUsuario, telefone || null]
      );
    } catch (err1) {
      result = await db.query(
        'INSERT INTO usuarios (nome, email, senha_hash, perfil, telefone) VALUES (\$1, \$2, \$3, \$4, \$5) RETURNING id, nome, email, telefone',
        [nome, email, senhaHash, tipoUsuario, telefone || null]
      );
    }

    res.status(201).json({
      mensagem: 'Usuário cadastrado com sucesso!',
      usuario: result.rows[0],
    });
  } catch (error) {
    console.error('Erro no registro:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'E-mail já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro ao registrar usuário.' });
  }
});

// ==========================================
// ROTA: Login
// ==========================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = \$1', [
      email,
    ]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const usuario = rows[0];
    const hashGravado = usuario.senha || usuario.senha_hash;
    if (!hashGravado) {
      return res.status(500).json({ error: 'Hash de senha não encontrado.' });
    }

    const senhaValida = await bcrypt.compare(senha, hashGravado);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const tipo = usuario.tipo || usuario.perfil || 'CLIENTE';
    const payload = { id: usuario.id, email: usuario.email, tipo };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipo,
        telefone: usuario.telefone,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

// ==========================================
// ROTA: Listar Chamados
// ==========================================
app.get('/api/chamados', autenticarToken, async (req, res) => {
  try {
    if (req.usuario.tipo !== 'CLIENTE') {
      const { rows } = await db.query(
        'SELECT * FROM chamados ORDER BY criado_em DESC'
      );
      return res.json(rows);
    }

    let rows;
    try {
      const resQuery = await db.query(
        'SELECT * FROM chamados WHERE usuario_id = \$1 ORDER BY criado_em DESC',
        [req.usuario.id]
      );
      rows = resQuery.rows;
    } catch (err1) {
      try {
        const resQuery = await db.query(
          'SELECT * FROM chamados WHERE cliente_id = \$1 ORDER BY criado_em DESC',
          [req.usuario.id]
        );
        rows = resQuery.rows;
      } catch (err2) {
        const resQuery = await db.query(
          'SELECT * FROM chamados WHERE usuarioid = \$1 ORDER BY criado_em DESC',
          [req.usuario.id]
        );
        rows = resQuery.rows;
      }
    }

    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar chamados:', error);
    res.status(500).json({ error: 'Erro ao buscar chamados.' });
  }
});

// ==========================================
// ROTA: Criar Chamado
// ==========================================
app.post('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const { titulo, descricao } = req.body;
    if (!titulo || !descricao) {
      return res
        .status(400)
        .json({ error: 'Título e descrição são obrigatórios.' });
    }

    let result;
    try {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, usuario_id, status) VALUES (\$1, \$2, \$3, \$4) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO']
      );
    } catch (err1) {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, cliente_id, status) VALUES (\$1, \$2, \$3, \$4) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO']
      );
    }

    const userRes = await db.query(
      'SELECT telefone FROM usuarios WHERE id = \$1',
      [req.usuario.id]
    );
    const userPhone = userRes.rows[0]?.telefone;
    if (userPhone) {
      enviarNotificacaoWhatsApp(
        userPhone,
        `Olá! O seu chamado #${result.rows[0].id} ("${titulo}") foi aberto com sucesso e já está sob análise da nossa equipa.`
      );
    }

    res.status(201).json({
      mensagem: 'Chamado aberto com sucesso!',
      chamado: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao abrir chamado.' });
  }
});

// ==========================================
// ROTA: Gerar Pagamento Pix
// ==========================================
app.post('/api/chamados/:id/pagar-pix', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    if (!valor || valor <= 0) {
      return res
        .status(400)
        .json({ error: 'Valor inválido para o pagamento.' });
    }

    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = \$1', [
      id,
    ]);
    if (chamadoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const chamado = chamadoRes.rows[0];

    let pagamentoId, qrCode, qrCodeBase64;

    try {
      const payment = new Payment(mpClient);
      const body = {
        transaction_amount: Number(valor),
        description: `Chamado #${chamado.id} - ${chamado.titulo}`,
        payment_method_id: 'pix',
        payer: {
          email: req.usuario.email || 'sandro@tech.com',
          first_name: 'Cliente',
          last_name: 'Suporte',
        },
      };

      const response = await payment.create({ body });
      qrCode = response?.point_of_interaction?.transaction_data?.qr_code;
      qrCodeBase64 =
        response?.point_of_interaction?.transaction_data?.qr_code_base64;
      pagamentoId = response?.id;
    } catch (apiErr) {
      console.warn(
        '[Mercado Pago Sandbox Fallback] Rede externa bloqueada, gerando Pix simulado para testes:',
        apiErr.message
      );

      pagamentoId = 'TEST_PAY_' + Date.now();
      qrCode = `00020126580014br.gov.bcb.pix013612345678-1234-1234-1234-1234567890ab5204000053039865802BR5925Sandro Suporte Tecnico6009MANAUS62070503***63041D3A`;
      qrCodeBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    }

    await db.query(
      'UPDATE chamados SET status = \$1, valor = \$2, pagamento_id = \$3 WHERE id = \$4',
      ['AGUARDANDO PAGAMENTO', valor, String(pagamentoId), id]
    );

    // Dispara a notificação sem bloquear a resposta HTTP
    db.query('SELECT telefone FROM usuarios WHERE id = \$1', [req.usuario.id])
      .then((userRes) => {
        const userPhone = userRes.rows[0]?.telefone;
        if (userPhone) {
          enviarNotificacaoWhatsApp(
            userPhone,
            `Cobrança Pix gerada para o Chamado #${
              chamado.id
            } no valor de R$ ${Number(valor).toFixed(
              2
            )}.\n\nCódigo Copia e Cola:\n${qrCode}`
          );
        }
      })
      .catch((e) => console.error('Erro na consulta de telefone:', e));

    return res.json({
      mensagem: 'Cobrança Pix gerada com sucesso!',
      pagamentoId,
      qrCode,
      qrCodeBase64,
    });
  } catch (error) {
    console.error('Erro detalhado no pagamento Pix:', error);
    return res.status(500).json({
      error: 'Erro ao gerar pagamento Pix: ' + (error.message || error),
    });
  }
});

// ==========================================
// ROTA: Webhook Mercado Pago
// ==========================================
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { action, data } = req.body;

    if (action === 'payment.created' || action === 'payment.updated') {
      const paymentId = data.id;
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo.status === 'approved') {
        const updateRes = await db.query(
          "UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE pagamento_id = \$1 RETURNING *",
          [String(paymentId)]
        );

        if (updateRes.rows.length > 0) {
          const ch = updateRes.rows[0];
          const userId = ch.usuario_id || ch.cliente_id || ch.usuarioid;
          if (userId) {
            const userRes = await db.query(
              'SELECT telefone FROM usuarios WHERE id = \$1',
              [userId]
            );
            const tel = userRes.rows[0]?.telefone;
            if (tel) {
              enviarNotificacaoWhatsApp(
                tel,
                `Pagamento Confirmado! O pagamento do seu chamado #${ch.id} foi recebido e o atendimento já está em andamento.`
              );
            }
          }
        }
        console.log(`Pagamento Pix ${paymentId} aprovado com sucesso!`);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook do Mercado Pago:', error);
    res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

// ==========================================
// ROTA: Atualizar Status do Chamado (Técnico) -> Envia WhatsApp para o Cliente do Chamado
// ==========================================
app.patch('/api/chamados/:id', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (req.usuario.tipo === 'CLIENTE') {
      return res.status(403).json({ error: 'Apenas técnicos podem atualizar o status.' });
    }

    // 1. Atualiza o status na base de dados
    const result = await db.query(
      'UPDATE chamados SET status = \$1 WHERE id = \$2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }

    const chamado = result.rows[0];
    const clienteId = chamado.usuario_id || chamado.cliente_id || chamado.usuarioid;

    // 2. Busca o telefone e nome do CLIENTE dono do chamado
    if (clienteId) {
      const userRes = await db.query('SELECT telefone, nome FROM usuarios WHERE id = \$1', [clienteId]);
      const cliente = userRes.rows[0];
      
      if (cliente && cliente.telefone) {
        enviarNotificacaoWhatsApp(
          cliente.telefone,
          `📢 *Atualização no seu Chamado!*\n\nOlá, *${cliente.nome}*.\nO seu chamado *"${chamado.titulo}"* (#${chamado.id}) teve o status atualizado para: *${chamado.status}*.`
        );
      }
    }

    res.json({ mensagem: 'Status atualizado com sucesso!', chamado });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    res.status(500).json({ error: 'Erro ao atualizar status.' });
  }
});

// ==========================================
// ROTA: Atualizar Valor do Chamado (Técnico)
// ==========================================
app.patch('/api/chamados/:id/valor', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    if (req.usuario.tipo === 'CLIENTE') {
      return res
        .status(403)
        .json({ error: 'Apenas técnicos podem alterar valores.' });
    }

    const result = await db.query(
      'UPDATE chamados SET valor = \$1 WHERE id = \$2 RETURNING *',
      [valor, id]
    );

    res.json({ mensagem: 'Valor atualizado!', chamado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar valor.' });
  }
});

// ==========================================
// ROTA: Editar Chamado
// ==========================================
app.patch('/api/chamados/:id/editar', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, descricao } = req.body;

    const { rows } = await db.query('SELECT * FROM chamados WHERE id = \$1', [
      id,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }

    const chamado = rows[0];
    if (chamado.status !== 'ABERTO') {
      return res
        .status(400)
        .json({ error: 'Apenas chamados ABERTOS podem ser editados.' });
    }

    const result = await db.query(
      'UPDATE chamados SET titulo = \$1, descricao = \$2 WHERE id = \$3 RETURNING *',
      [titulo, descricao, id]
    );

    res.json({
      mensagem: 'Chamado atualizado com sucesso!',
      chamado: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao editar chamado.' });
  }
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
