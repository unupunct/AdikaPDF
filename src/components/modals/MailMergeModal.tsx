/** Forms → Mail merge: fill the open form once for every row of a CSV / Excel table. */
import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Mails } from 'lucide-react';
import { usePDFStore } from '@/store/usePDFStore';
import { Button, Callout, Checkbox, Dialog, Field, Input, Select } from '@/components/ui/primitives';
import { errorMessage } from '@/actions/document';
import { fileNameFor, matchColumns, type DataTable } from '@/lib/mailMerge';

export function MailMergeModal() {
  const open = usePDFStore((s) => s.modal === 'mailmerge');
  const baseName = usePDFStore((s) => (s.fileName ?? 'form.pdf').replace(/\.pdf$/i, ''));
  const close = () => usePDFStore.getState().openModal(null);
  const [fields, setFields] = useState<string[] | null>(null);
  const [tableName, setTableName] = useState<string | null>(null);
  const [table, setTable] = useState<DataTable | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [flatten, setFlatten] = useState(false);
  const [output, setOutput] = useState<'files' | 'combined'>('files');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancel = useRef(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress(null);
    setFields(null);
    void import('@/actions/mailMerge')
      .then((m) => m.currentFormFields())
      .then(setFields)
      .catch((e) => setError(errorMessage(e)));
  }, [open]);

  useEffect(() => {
    if (fields && table) setMapping(matchColumns(fields, table.headers));
  }, [fields, table]);

  const pick = async () => {
    setError(null);
    try {
      const { pickMergeTable } = await import('@/actions/mailMerge');
      const t = await pickMergeTable();
      if (!t) return;
      setTable(t.table);
      setTableName(t.name);
      setPattern(`${baseName} {${t.table.headers[0]}}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const matched = Object.values(mapping).filter(Boolean).length;
  const run = async () => {
    if (!table) return;
    setRunning(true);
    cancel.current = false;
    try {
      const { runMailMerge } = await import('@/actions/mailMerge');
      const res = await runMailMerge({ table, mapping, flatten, output, pattern }, (done, total) => setProgress({ done, total }), () => cancel.current);
      if (!res) return;
      const store = usePDFStore.getState();
      store.toast(
        `Mail merge finished: ${res.written} of ${table.rows.length} document${table.rows.length === 1 ? '' : 's'}.${res.problems.length ? ` ${res.problems.slice(0, 3).join('; ')}` : ''}`,
        res.problems.length ? 'info' : 'success',
      );
      if (res.written) close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !running && close()}
      title="Mail merge"
      description="Fills this form once for every row of a table (CSV or Excel): one PDF per row, or all of them in one PDF. Columns are matched to the fields by name."
      width={640}
      testId="mailmerge-modal"
      footer={
        <>
          {running ? <Button onClick={() => (cancel.current = true)}>Stop</Button> : <Button onClick={close}>Close</Button>}
          <Button variant="primary" disabled={!table || !matched || running} onClick={() => void run()} data-testid="mailmerge-run">
            {running ? <Loader2 size={13} className="animate-spin" /> : <Mails size={13} />}
            {table ? `Create ${table.rows.length} document${table.rows.length === 1 ? '' : 's'}` : 'Create documents'}
          </Button>
        </>
      }
    >
      {error ? <Callout kind="error">{error}</Callout> : null}
      {fields && fields.length === 0 ? <Callout kind="warn">This document has no form fields. Add fields (or use Detect fields) first.</Callout> : null}
      <div className="mb-3 flex items-center gap-2">
        <Button onClick={() => void pick()} disabled={running || !fields?.length} data-testid="mailmerge-pick">
          <FileSpreadsheet size={14} /> Choose table…
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted" data-no-translate>
          {tableName ?? ''}
        </span>
        {table ? (
          <span className="text-xs text-muted" data-testid="mailmerge-summary">
            {`${table.rows.length} rows · ${matched} of ${fields?.length ?? 0} fields matched`}
          </span>
        ) : null}
      </div>
      {table && fields ? (
        <>
          <div className="mb-3 max-h-56 overflow-auto rounded-md border border-app" data-testid="mailmerge-mapping">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-panel-2 text-left text-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">Field</th>
                  <th className="px-2 py-1 font-medium">Column</th>
                  <th className="px-2 py-1 font-medium">First row</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f} className="border-t border-app">
                    <td className="px-2 py-1" data-no-translate>
                      {f}
                    </td>
                    <td className="px-2 py-1">
                      <Select
                        value={mapping[f] ?? ''}
                        ariaLabel={`Column for ${f}`}
                        onChange={(v: string) => setMapping((m) => ({ ...m, [f]: v }))}
                        options={[{ value: '', label: '(leave as is)' }, ...table.headers.map((h) => ({ value: h, label: h }))]}
                      />
                    </td>
                    <td className="max-w-[160px] truncate px-2 py-1 text-muted" data-no-translate>
                      {mapping[f] ? table.rows[0]?.[mapping[f]] : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Output">
              <Select
                value={output}
                ariaLabel="Output"
                onChange={(v: 'files' | 'combined') => setOutput(v)}
                options={[
                  { value: 'files', label: 'One PDF per row (in a folder)' },
                  { value: 'combined', label: 'All rows in one PDF' },
                ]}
              />
            </Field>
            {output === 'files' ? (
              <Field label="File names" hint="{Column} is replaced by the row's value, {#} by the row number.">
                <Input value={pattern} onChange={(e) => setPattern(e.target.value)} data-testid="mailmerge-pattern" />
              </Field>
            ) : null}
          </div>
          {output === 'files' && table.rows[0] ? (
            <p className="mb-2 text-[11px] text-muted">
              First file: <span data-no-translate data-testid="mailmerge-first-name">{fileNameFor(pattern || `${baseName} {#}`, table.rows[0], 0)}</span>
            </p>
          ) : null}
          <Checkbox
            checked={flatten || output === 'combined'}
            disabled={output === 'combined'}
            onChange={setFlatten}
            label={output === 'combined' ? 'Values are burned into the pages (always, in one combined PDF)' : 'Burn the values into the pages (no longer editable)'}
          />
        </>
      ) : null}
      {progress && running ? (
        <Callout kind="info">
          <span data-testid="mailmerge-progress">{`Document ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`}</span>
        </Callout>
      ) : null}
    </Dialog>
  );
}
