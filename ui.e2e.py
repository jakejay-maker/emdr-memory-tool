"""End-to-end UI test (Playwright + Chromium) of the chat interface, with proxy.php / pay.php mocked.
Run: python3 -m http.server 8765 &   then   python3 ui.e2e.py
Screenshots go to ./shots/. Does not touch Stripe or any AI provider."""
import json, os, re
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8765/index.html'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
INIT = "window.__T={setMs:700,cfg:{checkinTimeoutMs:2500,orientTimeoutMs:2500}}"
os.makedirs('shots', exist_ok=True)

def make_mock(M):
    def proxy(route):
        b = json.loads(route.request.post_data or '{}'); m = b.get('mode', 'story'); M['calls'].append(m)
        if m == 'lock': M['lock'] += 1; return route.fulfill(json={'ok': True})
        if m == 'risk':
            if M.get('risk_down'): return route.fulfill(status=500, json={'error': 'x'})
            t = (b.get('text') or '').lower()
            return route.fulfill(json={'level': 'amber' if 'floating' in t else 'green', 'signals': []})
        if m == 'image':
            if M.get('img_fail'): return route.fulfill(status=502, json={'error': 'generation_failed'})
            return route.fulfill(json={'b64': PNG})
        inp = json.loads(b.get('input') or '{}')
        if 'place' in inp: return route.fulfill(json={'title': 'Quiet Shore', 'lines': ['Warm sand under your feet.', 'The water is slow and soft.', 'Your friend sits beside you.'], 'bg_prompt': 'beach', 'figure_prompt': 'dog'})
        if 'headline' in inp: return route.fulfill(json={'name': 'Sir Grumblecloud', 'form': 'storm cloud', 'sprite_prompt': 'a grumpy storm cloud'})
        return route.fulfill(json={'title': 'Cloud Picnic', 'line': 'The cloud drifts a little farther, soft at the edges.'})
    def pay(route):
        a = route.request.url.split('a=')[-1]
        if a == 'admin': return route.fulfill(json={'token': 'abcdef0123456789.deadbeef', 'test': True})
        if a == 'refund': M['refund'] += 1; return route.fulfill(json={'ok': True})
        return route.fulfill(status=400, json={'error': 'x'})
    return proxy, pay

def new_page(browser, M, w=390, h=844, tz='America/Mexico_City'):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, timezone_id=tz); page = ctx.new_page()
    page.add_init_script(INIT); page.errors = []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    p, y = make_mock(M); page.route('**/proxy.php', p); page.route('**/pay.php*', y)
    return page

def mk(**k): return dict({'calls': [], 'lock': 0, 'refund': 0}, **k)
def chip(page, text, t=8000):
    loc = page.locator('button.chip.live', has_text=re.compile('^' + re.escape(text) + '$')).last; loc.wait_for(timeout=t); loc.click()
def has(page, text, t=8000): page.get_by_text(text).first.wait_for(timeout=t)
def scales(page, n=1, t=8000):
    page.wait_for_function('n => document.querySelectorAll(".scale").length && [...document.querySelectorAll(".scale")].filter(s => s.querySelector("button.live")).length >= n', arg=n, timeout=t)
    return page.locator('.scale:has(button.live)')
def rate(page, i): scales(page).first.locator('button.live').nth(i).click()
def pair(page, a, b): s = scales(page, 2); s.nth(0).locator('button').nth(a).click(); s.nth(1).locator('button').nth(b).click()
def type_(page, text):
    page.wait_for_function('!document.querySelector("#box").disabled', timeout=8000); page.fill('#box', text); page.press('#box', 'Enter')
def shot(page, n): page.screenshot(path=f'shots/{n}.png')

def consent_and_screen(page, **yes):
    page.goto(BASE + '#test'); chip(page, "I understand, let's begin")
    for k in ['adult', 'suicidal', 'psychosis', 'intoxicated', 'dissociativeDx', 'unsafeNow']:
        chip(page, 'Yes' if yes.get(k, k == 'adult') else 'No')
def to_stab(page):
    consent_and_screen(page); chip(page, 'Test mode'); type_(page, 'k' * 20)
    type_(page, 'a quiet beach with my dog'); scales(page)
def assessment(page, sud=5, typed_impact=False):
    rate(page, 8)                                   # presence at the safe place
    type_(page, 'a storm at the lake'); scales(page)
    (type_(page, '7') if typed_impact else rate(page, 5)); chip(page, "I'm not safe"); chip(page, 'Chest'); rate(page, sud)
    chip(page, 'I am safe now'); rate(page, 2)      # belief felt 3/7
def to_processing(page, sud=5, typed_impact=False):
    to_stab(page); assessment(page, sud, typed_impact); chip(page, 'Start')
def run_set(page): chip(page, 'Start')

ok = lambda m, c: (print(('PASS ' if c else 'FAIL ') + m), c)[1]
results = []
with sync_playwright() as pw:
    br = pw.chromium.launch()

    # A. happy path through the whole conversation (fallback art so screenshots show the cartoon style)
    M = mk(img_fail=True); page = new_page(br, M); page.goto(BASE + '#test'); has(page, 'Hi, and welcome'); shot(page, '01_welcome')
    consent_and_screen(page); chip(page, 'Test mode'); type_(page, 'k' * 20); has(page, 'Describe a place'); shot(page, '02_place_prompt')
    type_(page, 'a quiet beach with my dog'); scales(page); shot(page, '03_safe_place')
    rate(page, 8)
    type_(page, 'a storm at the lake'); scales(page); shot(page, '04_assessment')
    type_(page, '7'); chip(page, "I'm not safe"); chip(page, 'Chest'); rate(page, 5); chip(page, 'I am safe now'); rate(page, 2)
    has(page, 'Sir Grumblecloud, a storm cloud'); shot(page, '05_meet_creature')
    results.append(ok('A: creature is named and tagged', 'Sir Grumblecloud' in page.inner_text('#tag')))
    h = lambda: page.eval_on_selector('#tgt', 'e => parseFloat(e.style.height)')
    h0 = h(); page.click('#near'); page.click('#near'); h2 = h(); page.click('#back'); h1 = h()
    results.append(ok('A: it starts far; come closer grows it, step back shrinks it', h0 < h1 < h2))
    chip(page, 'Start'); page.wait_for_timeout(250); shot(page, '06_running'); scales(page, 2); shot(page, '07_checkin')
    results.append(ok('A: star earned for completing a set', '1' in page.inner_text('#stars')))
    pair(page, 4, 8); chip(page, 'Nothing new'); has(page, 'Chapter 1: Cloud Picnic'); shot(page, '08_chapter')
    chip(page, 'Start'); pair(page, 1, 8); chip(page, 'Next')
    page.wait_for_timeout(2200); results.append(ok('A: creature tucked into the chest at closure', page.eval_on_selector('#chest', 'e => e.style.display') == 'block' and page.eval_on_selector('#tgt', 'e => e.style.opacity') == '0')); shot(page, '09_chest')
    chip(page, 'Next'); rate(page, 5); pair(page, 1, 9); has(page, 'real result'); shot(page, '10_done')
    txt = page.inner_text('#log')
    results.append(ok('A: typed rating accepted (impact 7) and summary shows distress + belief change', 'Distress: 5' in txt and '3 → 6' in txt))
    results.append(ok('A: story chapters recapped', 'Your story' in txt))
    results.append(ok('A: no vendor name anywhere in the rendered page', 'openai' not in page.content().lower()))
    results.append(ok('A: risk checks ran on every typed message', M['calls'].count('risk') >= 3))
    results.append(ok('A: no page errors', not page.errors))

    # B. two ambers => red, lock, cooldown, crisis
    M = mk(); page = new_page(br, M); to_processing(page, 6)
    pair(page, 9, 7); has(page, 'We paused the exercise'); shot(page, '11_orient')
    results.append(ok('B: creature steps far away when we pause', page.eval_on_selector('#tgt', 'e => parseFloat(e.style.height)') == 18))
    pair(page, 4, 8); chip(page, 'Nothing new'); run_set(page); pair(page, 9, 7); has(page, "I'm pausing everything here"); shot(page, '12_crisis')
    page.wait_for_timeout(300)
    results.append(ok('B: crisis shows Linea de la Vida', 'Línea de la Vida' in page.inner_text('#log')))
    results.append(ok('B: server lock requested', M['lock'] == 1))
    results.append(ok('B: cooldown stored', page.evaluate("+localStorage.getItem('sm_cd')") > 0))
    page.reload(); has(page, 'Sessions are paused for now'); results.append(ok('B: reload lands on cooldown', True))

    # C. screen-out never reaches payment
    M = mk(); page = new_page(br, M); consent_and_screen(page, suicidal=True); has(page, 'refund is on its way')
    results.append(ok('C: excluded shows resources', 'Línea de la Vida' in page.inner_text('#log')))
    results.append(ok('C: payment never offered', page.locator('button.chip', has_text='Pay $2').count() == 0))

    # D. silence: check-in timeout => grounding => crisis
    M = mk(); page = new_page(br, M); to_processing(page)
    has(page, 'We paused the exercise', 8000); has(page, "I'm pausing everything here", 8000)
    results.append(ok('D: silence after a set leads to grounding, then crisis', True))

    # E. safety check down: no generation; local lexicon still catches self-harm text
    M = mk(risk_down=True); page = new_page(br, M); consent_and_screen(page); chip(page, 'Test mode'); type_(page, 'k' * 20)
    type_(page, 'a quiet beach'); has(page, "I can't run my safety check right now")
    results.append(ok('E1: check unavailable => nothing generated', 'image' not in M['calls'] and 'story' not in M['calls']))
    type_(page, 'I want to die'); has(page, "I'm pausing everything here")
    results.append(ok('E2: self-harm text => crisis even with the server down', True))

    # F. dissociation words while noticing => grounding
    M = mk(); page = new_page(br, M); to_processing(page)
    pair(page, 3, 8); type_(page, 'I feel like floating'); has(page, 'We paused the exercise')
    results.append(ok('F: dissociation language => grounding', True))

    # G. country default follows the time zone; the picker switches lists
    M = mk(); page = new_page(br, M, tz='America/New_York'); consent_and_screen(page, suicidal=True); has(page, 'refund is on its way')
    results.append(ok('G: US time zone defaults to 988', '988' in page.inner_text('#log')))
    page.select_option('#log select', 'MX'); results.append(ok('G: picker switches to Mexico list', '800 911 2000' in page.inner_text('#log')))

    # H. amber words in the headline => asks for a simpler version, still waiting
    M = mk(); page = new_page(br, M); to_stab(page); rate(page, 8); type_(page, 'I feel numb about it')
    has(page, 'That sounds like it might be a lot right now')
    results.append(ok('H: amber headline is not accepted; input stays open', page.eval_on_selector('#box', 'e => !e.disabled')))

    # I. distress above the cap is declined with a gentler prompt
    M = mk(); page = new_page(br, M); to_stab(page); assessment(page, sud=8)
    has(page, 'feels smaller'); results.append(ok('I: starting distress above the cap is declined', 'creature' not in ' '.join(M['calls'])))

    # desktop look
    M = mk(img_fail=True); page = new_page(br, M, 1100, 800); to_processing(page); page.wait_for_timeout(250); shot(page, '13_desktop')
    br.close()
print('\n%d/%d checks passed' % (sum(results), len(results)))
