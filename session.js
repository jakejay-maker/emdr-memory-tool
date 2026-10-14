/* session.js - guided session state machine + risk ladder.
 * Pure logic: no DOM, no network, no storage. Works in the browser (window.Session) and Node.
 * The UI feeds events in, and acts on the returned effects ("fx").
 *
 * Safety principle: this cannot DETECT dissociation or a distress flood. It watches proxies
 * (ratings, response behaviour, language) and fails SAFE: unsure, invalid or missing => pause.
 *
 * Flow: consent -> screening -> stabilize (safe place + presence check) -> target -> processing
 *       (sets + check-ins) -> closure -> done.  Side exits: excluded, not_ready, cooldown, red.
 */
(function (root) {
  'use strict';

  var CFG = {
    readyPresence: 6,      // presence (0-10) needed to start and to resume
    maxTargetSud: 6,       // refuse a target whose starting distress is above this
    doneSud: 1,            // processing counts as resolved at or below this
    resumeSud: 7,          // after grounding, distress must be <= this to resume
    amberSud: 8,           // check-in distress at/above this => amber
    amberJump: 3,          // rise vs previous rating => amber
    amberPresence: 4,      // presence at/below this => amber
    climbSets: 3,          // consecutive rising ratings => amber
    slowMs: 10000, slowFactor: 2.5,   // soft signal: slow answer
    hiddenMs: 10000,       // tab/app hidden this long mid-processing => amber
    checkinTimeoutMs: 15000, orientTimeoutMs: 30000,
    ambersToRed: 2,        // second amber in a session => red
    maxSets: 12, maxMs: 30 * 60 * 1000,
    cooldownMs: 24 * 3600 * 1000,
    maxGroundTries: 2, maxTargetDeclines: 2, maxOrientTries: 2, maxClosureTries: 2,
    maxPings: 3            // "I need a moment" taps that extend the grounding timer (a tap is a response)
  };

  // Backstop lexicon (EN + ES). The server classifier is the primary text signal; take the max.
  var RED_RX = /kill myself|killing myself|end my life|want to die|wanna die|better off dead|no reason to live|hurt myself|harm myself|suicid|me quiero morir|quiero morirme|quitarme la vida|matarme|hacerme da[nñ]o|lastimarme|mejor muert[oa]/i;
  var AMBER_RX = /\bnumb\b|going numb|floating|not (really )?here|not real|unreal|watching myself|outside (of )?my body|can'?t feel|cannot feel|spacing out|zoned out|can'?t breathe|panic|flooded|entumecid|adormecid|flotando|no estoy aqu[ií]|no es real|irreal|me veo desde afuera|fuera de mi cuerpo|no siento nada|no puedo respirar|p[aá]nico|abrumad/i;

  function textRisk(t) {
    if (!t || typeof t !== 'string') return 'green';
    if (RED_RX.test(t)) return 'red';
    if (AMBER_RX.test(t)) return 'amber';
    return 'green';
  }
  var ORDER = { green: 0, amber: 1, red: 2 };
  function maxLevel(a, b) { return ORDER[b] > ORDER[a] ? b : a; }
  function rating(x) { return typeof x === 'number' && isFinite(x) && x >= 0 && x <= 10; }

  // m: {sud, prevSud, presence, latencyMs, baselineMs, textLevel, climbs}
  function assess(m, cfg) {
    cfg = cfg || CFG;
    var reasons = [], level = 'green';
    function up(l, r) { level = maxLevel(level, l); reasons.push(r); }
    if (m.textLevel === 'red') up('red', 'self_harm_language');
    if (!rating(m.sud) || !rating(m.presence)) { up('amber', 'invalid_rating'); return { level: level, reasons: reasons }; }
    if (m.sud >= cfg.amberSud) up('amber', 'high_distress');
    if (rating(m.prevSud) && m.sud - m.prevSud >= cfg.amberJump) up('amber', 'distress_jump');
    if (m.presence <= cfg.amberPresence) up('amber', 'low_presence');
    if (m.textLevel === 'amber') up('amber', 'dissociation_language');
    if ((m.climbs || 0) >= cfg.climbSets) up('amber', 'rising_distress');
    var slow = m.latencyMs > Math.max(cfg.slowMs, cfg.slowFactor * (m.baselineMs || 0));
    if (slow && (m.presence <= 5 || m.sud >= 7)) up('amber', 'slow_and_distressed');
    return { level: level, reasons: reasons };
  }

  // Screening: every question must be answered. adult must be true; the rest must be false.
  function screen(a) {
    a = a || {};
    var must = ['adult', 'suicidal', 'psychosis', 'intoxicated', 'dissociativeDx', 'unsafeNow'];
    var missing = must.filter(function (k) { return typeof a[k] !== 'boolean'; });
    if (missing.length) return { complete: false, ok: false, reasons: missing };
    var reasons = [];
    if (!a.adult) reasons.push('under_18');
    ['suicidal', 'psychosis', 'intoxicated', 'dissociativeDx', 'unsafeNow'].forEach(function (k) { if (a[k]) reasons.push(k); });
    return { complete: true, ok: reasons.length === 0, reasons: reasons };
  }

  function create(o) {
    o = o || {};
    var now = o.now || Date.now();
    var s = {
      v: 1, state: 'consent', cfg: Object.assign({}, CFG, o.cfg || {}),
      clinicianConsent: !!o.clinicianConsent, cooldownUntil: o.cooldownUntil || 0,
      awaiting: null, deadline: 0, startedAt: null, targetStartedAt: null, baselineMs: null,
      groundTries: 0, targetDeclines: 0, orientTries: 0, closureTries: 0, pings: 0,
      ambers: 0, sets: 0, climbs: 0, targetSud: null, lastSud: null,
      presenceSeries: [], sudSeries: [], outcome: null, log: []
    };
    if (s.cooldownUntil > now) s.state = 'cooldown';
    return s;
  }

  // dispatch(state, event, now) -> {state, fx}. Never mutates the input state.
  function dispatch(prev, ev, now) {
    now = now || Date.now();
    var s = JSON.parse(JSON.stringify(prev)), c = s.cfg, fx = [], t = ev && ev.type;
    function log(type, reasons) { s.log.push({ t: now, type: type, reasons: reasons || [] }); }
    function wait(kind, ms) { s.awaiting = kind; s.deadline = now + ms; fx.push('timer:' + kind); }
    function toRed(reasons) {
      s.state = 'red'; s.awaiting = null; s.outcome = 'red'; s.cooldownUntil = now + c.cooldownMs;
      log('red', reasons); fx.push('bls_stop', 'show:crisis', 'lock', 'set_cooldown');
      if (s.clinicianConsent) fx.push('clinician_alert');
    }
    function toAmber(reasons) {
      s.ambers++; log('amber', reasons); fx.push('bls_stop');
      if (s.ambers >= c.ambersToRed) return toRed(reasons.concat('repeat_amber'));
      s.state = 'orienting'; s.orientTries = 0; s.pings = 0; fx.push('show:orient'); wait('orient', c.orientTimeoutMs);
    }
    function close(outcome) {
      s.state = 'closure'; s.awaiting = null; s.outcome = outcome; log('closure', [outcome]);
      fx.push('bls_stop', 'show:closure');
    }
    var live = ['stabilize', 'target', 'processing', 'orienting'];

    // ---- events valid in any live state ----
    if (t === 'TEXT_RISK' && s.state !== 'red' && s.state !== 'done' && s.state !== 'excluded' && s.state !== 'cooldown') {
      if (ev.level === 'red') { toRed(['self_harm_language']); return { state: s, fx: fx }; }
      if (ev.level === 'amber') {
        if (s.state === 'processing') toAmber(['dissociation_language']);
        else if (s.state === 'stabilize') fx.push('show:ground');
        return { state: s, fx: fx };
      }
    }
    if (t === 'STOP' && live.indexOf(s.state) >= 0) { close('stopped'); return { state: s, fx: fx }; }

    switch (s.state) {
      case 'consent':
        if (t === 'CONSENT' && ev.accepted === true) {
          s.clinicianConsent = !!ev.clinicianConsent; s.state = 'screening'; fx.push('show:screening');
        }
        break;

      case 'screening':
        if (t === 'SCREEN') {
          var r = screen(ev.answers);
          if (!r.complete) { fx.push('show:screening_incomplete'); break; }
          if (!r.ok) { s.state = 'excluded'; s.outcome = 'excluded'; log('excluded', r.reasons); fx.push('refund', 'show:excluded'); break; }
          s.state = 'stabilize'; s.startedAt = now; fx.push('show:safe_place');
        }
        break;

      case 'stabilize':
        if (t === 'STAB_DONE') {
          if (rating(ev.latencyMs)) s.baselineMs = ev.latencyMs;
          if (rating(ev.presence)) s.presenceSeries.push(ev.presence);
          if (rating(ev.presence) && ev.presence >= c.readyPresence) { s.state = 'target'; fx.push('show:target'); break; }
          s.groundTries++;
          if (s.groundTries >= c.maxGroundTries) { s.state = 'not_ready'; s.outcome = 'not_ready'; log('not_ready'); fx.push('refund', 'show:not_ready'); }
          else fx.push('show:ground');
        }
        break;

      case 'target':
        if (t === 'TARGET') {
          if (!rating(ev.sud)) { fx.push('show:target'); break; }
          if (ev.sud > c.maxTargetSud) {
            s.targetDeclines++; log('target_declined', ['sud_too_high']);
            if (s.targetDeclines >= c.maxTargetDeclines) close('target_declined'); else fx.push('show:target_declined');
            break;
          }
          s.state = 'processing'; s.targetSud = ev.sud; s.lastSud = ev.sud; s.sudSeries.push(ev.sud);
          s.targetStartedAt = now; s.climbs = 0; fx.push('show:set');
        }
        break;

      case 'processing':
        if (t === 'SET_DONE') {
          s.sets++; fx.push('bls_stop', 'show:checkin'); wait('checkin', c.checkinTimeoutMs);
        } else if (t === 'CHECKIN' && s.awaiting === 'checkin') {
          var climbs = (rating(ev.sud) && rating(s.lastSud) && ev.sud > s.lastSud) ? s.climbs + 1 : 0;
          var a = assess({ sud: ev.sud, prevSud: s.lastSud, presence: ev.presence, latencyMs: ev.latencyMs,
            baselineMs: s.baselineMs, textLevel: ev.textLevel, climbs: climbs }, c);
          if (rating(ev.sud)) { s.sudSeries.push(ev.sud); s.lastSud = ev.sud; }
          if (rating(ev.presence)) s.presenceSeries.push(ev.presence);
          s.climbs = climbs; s.awaiting = null;
          if (a.level === 'red') toRed(a.reasons);
          else if (a.level === 'amber') toAmber(a.reasons);
          else if (ev.sud <= c.doneSud) close('resolved');
          else if (s.sets >= c.maxSets || now - s.targetStartedAt >= c.maxMs) close('cap_reached');
          else fx.push('show:set');
        } else if (t === 'CHECKIN_TIMEOUT' && s.awaiting === 'checkin' && now >= s.deadline) {
          toAmber(['no_response']);
        } else if (t === 'TAB_HIDDEN' && ev.ms >= c.hiddenMs) {
          toAmber(['tab_hidden']);
        }
        break;

      case 'orienting':
        if (t === 'ORIENT_DONE') {
          var ok = rating(ev.presence) && rating(ev.sud) && ev.presence >= c.readyPresence && ev.sud <= c.resumeSud;
          if (rating(ev.presence)) s.presenceSeries.push(ev.presence);
          if (ok) { s.state = 'processing'; s.awaiting = null; s.lastSud = ev.sud; s.climbs = 0; log('resumed'); fx.push('show:set'); }
          else {
            s.orientTries++;
            if (s.orientTries >= c.maxOrientTries) close('not_recovered');
            else { fx.push('show:orient'); wait('orient', c.orientTimeoutMs); }
          }
        } else if (t === 'ORIENT_PING') {
          if (s.pings < c.maxPings) { s.pings++; wait('orient', c.orientTimeoutMs); }
        } else if (t === 'CHECKIN_TIMEOUT' && s.awaiting === 'orient' && now >= s.deadline) {
          toRed(['no_response_after_grounding']);
        }
        break;

      case 'closure':
        if (t === 'CLOSURE_DONE') {
          if (rating(ev.sud)) s.sudSeries.push(ev.sud);
          if (rating(ev.presence)) s.presenceSeries.push(ev.presence);
          if (rating(ev.presence) && ev.presence >= c.readyPresence) { s.state = 'done'; fx.push('show:done'); }
          else {
            s.closureTries++;
            if (s.closureTries >= c.maxClosureTries) { s.state = 'done'; log('closed_unsettled'); fx.push('show:done', 'show:safety_net'); }
            else fx.push('show:ground');
          }
        }
        break;
    }
    return { state: s, fx: fx };
  }

  // Summary for the user / an opted-in clinician link. Ratings and event types only - never narrative text.
  function summary(s) {
    return {
      outcome: s.outcome, sets: s.sets, ambers: s.ambers, targetSud: s.targetSud,
      sudSeries: s.sudSeries, presenceSeries: s.presenceSeries,
      durationMs: s.startedAt ? (s.log.length ? s.log[s.log.length - 1].t - s.startedAt : 0) : 0,
      events: s.log.map(function (e) { return { t: e.t, type: e.type, reasons: e.reasons }; })
    };
  }

  var api = { CFG: CFG, create: create, dispatch: dispatch, assess: assess, screen: screen, textRisk: textRisk, maxLevel: maxLevel, summary: summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Session = api;
})(typeof window !== 'undefined' ? window : this);
