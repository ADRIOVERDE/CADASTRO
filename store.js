// =====================================================
// Camada de dados — Supabase (nuvem) + cache em memória
// =====================================================
// Todos os dados das pessoas ficam no Supabase (banco na nuvem).
// Qualquer dispositivo que abrir o painel vê os mesmos dados.
// O cache em memória permite leitura instantânea (síncrona).
// Escritas disparam para o Supabase em segundo plano (async).

// --- Supabase ---
var SUPABASE_URL = 'https://kyxxlkqfzrrcikcajyjt.supabase.co/rest/v1/';
var SUPABASE_KEY = 'sb_publishable_t3pBGGgcuGtAaKkNinOESw_wzC6Ruuq';

// --- inChurch API via proxy (evita CORS no navegador) ---
// O proxy (index.ts no Supabase) é genérico: repassa qualquer caminho
// que vier depois de "/inchurch-proxy" direto pra API do inChurch.
var INCHURCH_PROXY_URL = 'https://kyxxlkqfzrrcikcajyjt.supabase.co/functions/v1/inchurch-proxy';
var INCHURCH_CHURCH_ID = 36014;

// --- Mapeamento opcional: congregação -> church_id no inChurch ---
// Preencha aqui se cada congregação sua for uma "igreja" separada no
// inChurch. Deixe vazio {} se todas usam o mesmo INCHURCH_CHURCH_ID.
// Exemplo: { 'Sede': 36014, 'Congregação Bairro X': 40021 }
var CONGREGACAO_CHURCH_ID = {};

// OBS sobre Grupo de Crescimento (GC): no inChurch, GC = Célula, e a API
// pública de Células (/v1/cell/) é SOMENTE LEITURA — não existe endpoint
// para vincular uma pessoa a uma célula via API. Por isso "quisGC" fica
// só registrado aqui no Supabase mesmo; não tem como sincronizar
// automaticamente com o inChurch até eles abrirem esse endpoint.

// --- Mapeamento opcional: nome do departamento -> ID do grupo no inChurch ---
// Mesma lógica do GC acima. Exemplo: { 'UCADERV': 501, 'MAAD': 502 }
var DEPARTAMENTO_GROUP_ID = {};

// --- Cache em memória ---
var _peopleCache = [];

// --- Constantes da jornada ---
const ENTRY_STAGES = ['visitante', 'convertido', 'reconciliado', 'novo_membro'];
const LINEAR_STAGES = ['gc', 'jornada_membro', 'membro'];
const STAGES = [
  { id:'visitante',      label:'Visitante',           desc:'Veio conhecer a igreja', icon:'ti-door-enter', accent:'blue' },
  { id:'convertido',     label:'Aceitou a Jesus',      desc:'Novo convertido, primeira vez', icon:'ti-sparkles', accent:'blue' },
  { id:'reconciliado',   label:'Reconciliado',         desc:'Voltou a andar com Jesus', icon:'ti-refresh', accent:'blue' },
  { id:'novo_membro',    label:'Novo membro',          desc:'Veio de outra igreja (transferência)', icon:'ti-suitcase', accent:'blue' },
  { id:'gc',             label:'Grupo de crescimento', desc:'Em célula, sendo integrado', icon:'ti-users', accent:'blue' },
  { id:'jornada_membro', label:'Jornada do membro',    desc:'Consolidação e/ou escola de batismo', icon:'ti-compass', accent:'ember' },
  { id:'membro',         label:'Membro',               desc:'Jornada concluída', icon:'ti-award', accent:'green' },
];
const SUB_STAGES = [
  { id:'consolidacao',    label:'Consolidação',      desc:'Acompanhamento e discipulado', icon:'ti-heart-handshake', accent:'ember' },
  { id:'escola_batismo',  label:'Escola de batismo', desc:'Preparação doutrinária', icon:'ti-book', accent:'ember' },
  { id:'capacitacao',     label:'Capacitação',       desc:'Treinamento para servir', icon:'ti-school', accent:'ember' },
  { id:'voluntariado',    label:'Voluntariado',      desc:'Primeiros passos servindo', icon:'ti-hand-stop', accent:'ember' },
];
const SUB_ORDER = ['consolidacao', 'escola_batismo', 'capacitacao', 'voluntariado'];

function nextStageId(stageId){
  if(ENTRY_STAGES.includes(stageId)) return 'gc';
  var i = LINEAR_STAGES.indexOf(stageId);
  if(i === -1 || i === LINEAR_STAGES.length-1) return null;
  return LINEAR_STAGES[i+1];
}
function prevStageId(stageId, person){
  if(stageId === 'gc'){
    var origem = person && person.origem;
    return ENTRY_STAGES.includes(origem) ? origem : null;
  }
  var i = LINEAR_STAGES.indexOf(stageId);
  if(i === 0 || i === -1) return null;
  return LINEAR_STAGES[i-1];
}
function nextSubStageId(subStageId){
  var i = SUB_ORDER.indexOf(subStageId);
  if(i === -1 || i === SUB_ORDER.length-1) return null;
  return SUB_ORDER[i+1];
}
function prevSubStageId(subStageId){
  var i = SUB_ORDER.indexOf(subStageId);
  if(i === 0 || i === -1) return null;
  return SUB_ORDER[i-1];
}

// --- Helper: chamada Supabase REST ---
async function supabaseRequest(method, table, body, query){
  var url = SUPABASE_URL + '/' + table;
  if(query) url += '?' + query;
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if(method !== 'GET') headers['Prefer'] = 'return=minimal';
  try{
    var opts = { method:method, headers:headers };
    if(body) opts.body = JSON.stringify(body);
    var res = await fetch(url, opts);
    if(!res.ok){
      var errText = await res.text();
      console.error('Supabase erro:', method, res.status, errText);
      return null;
    }
    if(method === 'GET') return await res.json();
    return true;
  }catch(err){
    console.error('Supabase falha:', method, err);
    return null;
  }
}

// --- Helper: chamada à API do inChurch via proxy ---
async function inchurchRequest(method, path, body){
  try{
    var res = await fetch(INCHURCH_PROXY_URL + path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var text = await res.text();
    var json = null;
    try{ json = text ? JSON.parse(text) : null; }catch(e){ /* resposta não era JSON */ }
    if(!res.ok){
      console.error('[inChurch]', method, path, res.status, text);
      return { ok:false, status:res.status, error:text, data:json };
    }
    return { ok:true, status:res.status, data:json };
  }catch(err){
    console.error('[inChurch] falha de rede:', method, path, err);
    return { ok:false, status:0, error:String(err), data:null };
  }
}

// --- Mapeamento JS (camelCase) ↔ DB (snake_case) ---
function toDb(p){
  return {
    id: p.id,
    nome: p.nome || '',
    nome_cadastrador: p.nomeCadastrador || '',
    telefone: p.telefone || '',
    email: p.email || '',
    bairro: p.bairro || '',
    idade: p.idade || '',
    estado_civil: p.estadoCivil || '',
    nome_conjuge: p.nomeConjuge || '',
    igreja_anterior: p.igrejaAnterior || '',
    tem_carta: p.temCarta || '',
    funcao_ministerial: p.funcaoMinisterial || '',
    quis_gc: p.quisGC || '',
    pedido_oracao: p.pedidoOracao || '',
    congregacao: p.congregacao || '',
    quem_coleta: p.quemColeta || '',
    departamento: p.departamento || '',
    agente_integrante: p.agenteIntegrante || '',
    sub_stage: p.subStage || '',
    notas: p.notas || '',
    foto: p.foto || null,
    stage: p.stage || 'visitante',
    origem: p.origem || '',
    inchurch_id: p.inchurchId || null,
    pending_sync: p.pendingSync || false,
    pending_sync_membro: p.pendingSyncMembro || false,
    sync_error: p.syncError || '',
    created_at: p.createdAt || new Date().toISOString(),
    history: JSON.stringify(p.history || []),
    sub_history: JSON.stringify(p.subHistory || [])
  };
}

function fromDb(row){
  return {
    id: row.id,
    nome: row.nome || '',
    nomeCadastrador: row.nome_cadastrador || '',
    telefone: row.telefone || '',
    email: row.email || '',
    bairro: row.bairro || '',
    idade: String(row.idade || ''),
    estadoCivil: row.estado_civil || '',
    nomeConjuge: row.nome_conjuge || '',
    igrejaAnterior: row.igreja_anterior || '',
    temCarta: row.tem_carta || '',
    funcaoMinisterial: row.funcao_ministerial || '',
    quisGC: row.quis_gc || '',
    pedidoOracao: row.pedido_oracao || '',
    congregacao: row.congregacao || '',
    quemColeta: row.quem_coleta || '',
    departamento: row.departamento || '',
    agenteIntegrante: row.agente_integrante || '',
    subStage: row.sub_stage || '',
    notas: row.notas || '',
    foto: row.foto || null,
    stage: row.stage || 'visitante',
    origem: row.origem || '',
    inchurchId: row.inchurch_id || null,
    pendingSync: row.pending_sync || false,
    pendingSyncMembro: row.pending_sync_membro || false,
    syncError: row.sync_error || '',
    createdAt: row.created_at || new Date().toISOString(),
    history: typeof row.history === 'string' ? JSON.parse(row.history || '[]') : (row.history || []),
    subHistory: typeof row.sub_history === 'string' ? JSON.parse(row.sub_history || '[]') : (row.sub_history || [])
  };
}

// --- Store ---
const Store = {
  _keyResp: 'jornada_responsaveis',
  _keyDeptos: 'jornada_departamentos',

  async load(){
    var rows = await supabaseRequest('GET', 'pessoas', null, 'select=*');
    if(rows && Array.isArray(rows)){
      _peopleCache = rows.map(fromDb);
    }
    return _peopleCache;
  },

  getPeople(){
    return _peopleCache;
  },

  addPerson(data){
    var stage = data.stage || 'visitante';
    var p = {
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      nome: data.nome || '',
      nomeCadastrador: data.nomeCadastrador || '',
      telefone: data.telefone || '',
      email: data.email || '',
      bairro: data.bairro || '',
      idade: data.idade || '',
      estadoCivil: data.estadoCivil || '',
      nomeConjuge: data.nomeConjuge || '',
      igrejaAnterior: data.igrejaAnterior || '',
      temCarta: data.temCarta || '',
      funcaoMinisterial: data.funcaoMinisterial || '',
      quisGC: data.quisGC || '',
      pedidoOracao: data.pedidoOracao || '',
      congregacao: data.congregacao || '',
      quemColeta: data.quemColeta || '',
      departamento: data.departamento || '',
      agenteIntegrante: data.agenteIntegrante || '',
      subStage: data.subStage || '',
      notas: data.notas || '',
      foto: data.foto || null,
      stage: stage,
      origem: stage,
      inchurchId: null,
      pendingSync: false,
      pendingSyncMembro: false,
      syncError: '',
      createdAt: new Date().toISOString(),
      history: [{ stage: stage, date: new Date().toISOString() }],
      subHistory: [],
    };
    _peopleCache.push(p);
    supabaseRequest('POST', 'pessoas', toDb(p));
    if(stage !== 'visitante'){ this.syncPreCadastro(p); }
    return p;
  },

  updatePerson(id, data){
    var p = _peopleCache.find(function(x){ return x.id === id; });
    if(!p) return null;
    Object.assign(p, data);
    supabaseRequest('PATCH', 'pessoas', toDb(p), 'id=eq.' + id);
    return p;
  },

  movePerson(id, newStageId){
    var p = _peopleCache.find(function(x){ return x.id === id; });
    if(!p) return null;
    p.stage = newStageId;
    p.history = p.history || [];
    p.history.push({ stage: newStageId, date: new Date().toISOString() });
    supabaseRequest('PATCH', 'pessoas', toDb(p), 'id=eq.' + id);
    if(newStageId === 'membro'){ this.syncMembroFinal(p); }
    return p;
  },

  moveSubStage(id, newSubStageId){
    var p = _peopleCache.find(function(x){ return x.id === id; });
    if(!p) return null;
    p.subStage = newSubStageId;
    p.subHistory = p.subHistory || [];
    p.subHistory.push({ subStage: newSubStageId, date: new Date().toISOString() });
    supabaseRequest('PATCH', 'pessoas', toDb(p), 'id=eq.' + id);
    return p;
  },

  deletePerson(id){
    _peopleCache = _peopleCache.filter(function(p){ return p.id !== id; });
    supabaseRequest('DELETE', 'pessoas', null, 'id=eq.' + id);
  },

  peopleInStage(stageId, congregacao){
    return _peopleCache.filter(function(p){
      return p.stage === stageId && (!congregacao || congregacao === 'todas' || p.congregacao === congregacao);
    });
  },

  peopleInSubStage(subStageId){
    return _peopleCache.filter(function(p){
      return p.stage === 'jornada_membro' && p.subStage === subStageId;
    });
  },

  congregacoes(){
    return Array.from(new Set(_peopleCache.map(function(p){ return p.congregacao; }).filter(Boolean))).sort();
  },

  getResponsaveis(){
    return JSON.parse(localStorage.getItem(this._keyResp) || '{}');
  },
  setResponsavel(stageId, nome){
    var r = this.getResponsaveis();
    r[stageId] = nome;
    localStorage.setItem(this._keyResp, JSON.stringify(r));
  },
  getDepartamentos(){
    var saved = JSON.parse(localStorage.getItem(this._keyDeptos) || 'null');
    return saved || ['UCADERV', 'MAAD', 'UMADERV', 'USADERV', 'HCP'];
  },
  setDepartamentos(list){
    localStorage.setItem(this._keyDeptos, JSON.stringify(list));
  },

  async syncPreCadastro(person){
    console.log('[inChurch] Iniciando pré-cadastro para:', person.nome);

    // status aceita apenas: pending | approved | refused
    // church_profile aceita apenas: visitor | frequent | member
    var churchProfileMap = {
      'visitante': 'visitor',
      'convertido': 'frequent',
      'reconciliado': 'frequent',
      'novo_membro': 'member'
    };
    var statusMap = {
      'visitante': 'pending',
      'convertido': 'pending',
      'reconciliado': 'approved',
      'novo_membro': 'approved'
    };

    var churchId = Number(person.congregacao) || CONGREGACAO_CHURCH_ID[person.congregacao] || INCHURCH_CHURCH_ID;

    var body = {
      full_name: person.nome,
      email: person.email,
      mobile_phone: person.telefone,
      church_id: churchId,
      status: statusMap[person.stage] || 'pending',
      church_profile: churchProfileMap[person.stage] || 'visitor',
      accepted_jesus: person.stage !== 'visitante',
      first_visit_date: new Date().toISOString().split('T')[0]
    };

    if(person.estadoCivil){ body.marital_status = person.estadoCivil; }
    if(person.igrejaAnterior){ body.previous_church = person.igrejaAnterior; }

    // Junta carta de transferência + função ministerial num único campo de texto livre,
    // já que a API não tem um campo específico para cada um.
    var joiningReasonParts = [];
    if(person.temCarta){ joiningReasonParts.push('Carta de transferência: ' + person.temCarta); }
    if(person.funcaoMinisterial){ joiningReasonParts.push('Função ministerial anterior: ' + person.funcaoMinisterial); }
    if(joiningReasonParts.length){ body.joining_reason = joiningReasonParts.join(' | '); }

    // Bairro vai dentro do objeto location (endereço)
    if(person.bairro){
      body.location_type = 'national';
      body.location = { neighborhood: person.bairro };
    }

    console.log('[inChurch] Body:', JSON.stringify(body));
    var result = await inchurchRequest('POST', '/v1/people/', body);

    if(!result.ok){
      this.updatePerson(person.id, { pendingSync: true, syncError: result.error || 'Erro desconhecido' });
      return;
    }

    var inchurchId = result.data && result.data.id;
    console.log('[inChurch] Sucesso! ID:', inchurchId);
    this.updatePerson(person.id, { pendingSync: false, inchurchId: inchurchId || null, syncError: '' });

    // Vincula ao Departamento, se informado e o ID do grupo estiver configurado
    // (isso usa Group Segmentation, que é diferente de Células — ver OBS acima)
    if(inchurchId && person.departamento && DEPARTAMENTO_GROUP_ID[person.departamento]){
      await inchurchRequest('POST', '/v1/group/' + DEPARTAMENTO_GROUP_ID[person.departamento] + '/memberships/', { person: inchurchId });
    }
  },

  async syncMembroFinal(person){
    if(!person.inchurchId){
      this.updatePerson(person.id, { pendingSyncMembro: true, syncError: 'Sem inchurchId' });
      return;
    }
    console.log('[inChurch] Marcando como membro:', person.nome, '(ID:', person.inchurchId, ')');

    var churchId = Number(person.congregacao) || CONGREGACAO_CHURCH_ID[person.congregacao] || INCHURCH_CHURCH_ID;

    // status só aceita pending | approved | refused — "active" não existe no schema oficial.
    var body = {
      full_name: person.nome,
      status: 'approved',
      church_profile: 'member',
      accepted_jesus: true,
      is_active: true,
      church_id: churchId
    };
    if(person.estadoCivil){ body.marital_status = person.estadoCivil; }

    var result = await inchurchRequest('PATCH', '/v1/people/' + person.inchurchId + '/', body);

    if(!result.ok){
      this.updatePerson(person.id, { pendingSyncMembro: true, syncError: result.error || 'Erro desconhecido' });
      return;
    }
    this.updatePerson(person.id, { pendingSyncMembro: false, syncError: '' });
  },
};

// --- Helpers de UI ---
function initials(name){
  return (name||'?').trim().split(/\s+/).slice(0,2).map(function(w){ return w[0]; }).join('').toUpperCase();
}
function avatarHtml(p, size){
  if(p.foto){ return '<img class="avatar" src="'+p.foto+'" style="width:'+size+'px;height:'+size+'px">'; }
  return '<div class="avatar" style="width:'+size+'px;height:'+size+'px;font-size:'+Math.round(size*0.36)+'px">'+initials(p.nome)+'</div>';
}
function daysSince(dateStr){
  var d = Math.floor((Date.now() - new Date(dateStr).getTime())/86400000);
  if(d === 0 || d === -1) return 'hoje';
  if(d === 1) return 'há 1 dia';
  return 'há '+d+' dias';
}
function lastHistoryDate(p){
  if(p.history && p.history.length) return p.history[p.history.length-1].date;
  return p.createdAt;
}