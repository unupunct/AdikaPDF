import { describe, expect, it } from 'vitest';
import { buildXfaModel } from '@/lib/pdf/xfaScript/model';
import { runXfaScripts } from '@/lib/pdf/xfaScript/run';
import { nodeVmEngine, quickJsEngine } from '@/lib/pdf/xfaScript/engines';
import { loadQuickSandbox } from './helpers/sandboxEnv';

// A synthetic declaration form in the style of the ANAF ones: script objects
// that validate and build the XML, a repeating section, a JavaScript and a
// FormCalc calculation, a variables text used as a global, a check button.
const js = (code: string) => `<script contentType="application/x-javascript">${code.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</script>`;
const TEMPLATE = `<?xml version="1.0"?>
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb">
  <variables>
    <text name="errMsg">start</text>
    <script name="util2" contentType="application/x-javascript">${js(`
      var calls = 0;
      function EL(s) { calls++; return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
    `).replace(/^<script[^>]*>|<\/script>$/g, '')}</script>
    <script name="gen" contentType="application/x-javascript">${js(`
      function xml() {
        var x = '<?xml version="1.0"?>\\n<declaratie999 cui="' + util2.EL(antet.cui.rawValue) + '" total="' + total.rawValue + '"';
        x += ' bifa="' + antet.bifa.rawValue + '">';
        var n = form1.rand.all.length;
        for (var i = 0; i < n; i++) {
          var r = form1.rand.all.item(i);
          x += '\\n\\t<rand nr="' + (i + 1) + '" suma="' + r.suma.rawValue + '"/>';
        }
        return x + '\\n</declaratie999>';
      }
      function valid() {
        if (antet.cui.isNull) return 'CUI lipsa';
        return '';
      }
    `).replace(/^<script[^>]*>|<\/script>$/g, '')}</script>
  </variables>
  <subform name="antet">
    <field name="cui"><ui><textEdit/></ui><validate nullTest="error"/><assist><toolTip>CUI</toolTip></assist></field>
    <field name="bifa"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items><value><integer/></value></field>
  </subform>
  <subform name="rand" layout="lr-tb">
    <occur min="1" max="-1" initial="1"/>
    <field name="suma"><ui><numericEdit/></ui><value><decimal/></value>
      <event activity="exit">${js('if (this.rawValue < 0) { xfa.host.messageBox("negativ"); this.rawValue = 0; }')}</event>
    </field>
    <field name="dublu"><ui><numericEdit/></ui><value><decimal/></value>
      <calculate><script>$ = suma * 2</script></calculate>
    </field>
  </subform>
  <field name="adauga"><ui><button/></ui>
    <event activity="click">${js('_rand.addInstance(1); xfa.form.recalculate(1);')}</event>
  </field>
  <field name="total"><ui><numericEdit/></ui><value><decimal/></value>
    <calculate>${js('var s = 0; for (var i = 0; i < _rand.count; i++) s += xfa.resolveNode("form1.rand[" + i + "].suma").rawValue; s')}</calculate>
  </field>
  <field name="totalFc"><ui><numericEdit/></ui><value><decimal/></value>
    <calculate><script>sum(form1.rand[*].dublu)</script></calculate>
  </field>
  <field name="valideaza"><ui><button/></ui>
    <event activity="mouseUp">${js('errMsg.value = "checked";')}</event>
    <event activity="click">${js(`
      var e = gen.valid();
      var doc = event.target;
      doc.removeDataObject("D999.xml");
      if (e === "") { doc.createDataObject("D999.xml", gen.xml()); xfa.host.messageBox("Validarea s-a terminat cu succes !"); }
      else { doc.createDataObject("Erori.txt", e); app.alert(e); }
    `)}</event>
  </field>
</subform>
</template>`;

const STEPS: Array<['fill', string, string | number] | ['click', string]> = [
  ['fill', 'form1.antet.cui', '18547290'],
  ['fill', 'form1.antet.bifa', 1],
  ['fill', 'form1.rand.suma', 100],
  ['click', 'form1.adauga'],
  ['fill', 'form1.rand[1].suma', -5],
  ['click', 'form1.adauga'],
  ['fill', 'form1.rand[2].suma', 50.5],
  ['click', 'form1.valideaza'],
];

const EXPECTED_XML = '<?xml version="1.0"?>\n<declaratie999 cui="18547290" total="150.5" bifa="1">\n\t<rand nr="1" suma="100"/>\n\t<rand nr="2" suma="0"/>\n\t<rand nr="3" suma="50.5"/>\n</declaratie999>';

describe('XFA script runtime (research prototype)', () => {
  it('builds the script model of a template', () => {
    const m = buildXfaModel(TEMPLATE);
    expect(m.stats).toMatchObject({ fields: 8, js: 7, formcalc: 2, scriptObjects: 2 });
    const form1 = m.root.children[0];
    expect(form1.dataVars).toEqual([{ name: 'errMsg', value: 'start' }]);
    expect(form1.children.find((c) => c.name === 'rand')?.occur).toEqual({ min: 1, max: -1, initial: 1 });
  });

  for (const engine of ['node-vm', 'quickjs'] as const) {
    it(`runs a declaration flow to the attached XML in ${engine}`, async () => {
      const e = engine === 'node-vm' ? nodeVmEngine(10_000) : quickJsEngine(await loadQuickSandbox(), (globalThis as unknown as { window: never }).window);
      const r = await runXfaScripts(e, buildXfaModel(TEMPLATE), { steps: STEPS });
      expect(r.errors).toEqual([]);
      expect(r.messages.filter((m) => m.kind === 'messageBox').map((m) => m.text)).toEqual(['negativ', 'Validarea s-a terminat cu succes !']);
      expect(r.dataObjects).toEqual([{ name: 'D999.xml', contents: EXPECTED_XML }]);
      // JavaScript and FormCalc calculations over the repeated rows
      expect(r.values['xfa[0].form[0].form1[0].total[0]']).toBe(150.5);
      expect(r.values['xfa[0].form[0].form1[0].totalFc[0]']).toBe(301);
      expect(r.values['xfa[0].form[0].form1[0].rand[2].dublu[0]']).toBe(101);
    });
  }

  it('reports what the form needs and the runtime lacks', async () => {
    const tpl = TEMPLATE.replace('_rand.addInstance(1);', 'xfa.layout.relayout(); xfa.host.unknownCall();');
    const r = await runXfaScripts(nodeVmEngine(10_000), buildXfaModel(tpl), { steps: [['click', 'form1.adauga']] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ node: 'xfa[0].form[0].form1[0].adauga[0]', event: 'click' });
    expect(r.summary.distinctFailed).toBe(1);
  });

  it('without a valid CUI attaches the errors instead of the XML', async () => {
    const r = await runXfaScripts(nodeVmEngine(10_000), buildXfaModel(TEMPLATE), { steps: [['click', 'form1.valideaza']] });
    expect(r.dataObjects).toEqual([{ name: 'Erori.txt', contents: 'CUI lipsa' }]);
    expect(r.messages.some((m) => m.kind === 'alert' && m.text === 'CUI lipsa')).toBe(true);
  });
});
