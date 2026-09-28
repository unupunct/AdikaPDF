import { FolderOpen, ShieldCheck, Signature, Usb } from 'lucide-react';
import { QuickToolGrid, startQuickTool } from '@/components/modals/ToolsModal';
import { openDialog } from '@/actions/document';
import { usePDFStore } from '@/store/usePDFStore';
import { useModalArgs, type ImportKind } from '@/store/useModalArgs';
import { AdikaLogo } from './AdikaLogo';
import { openRecent, useRecentFiles } from '@/components/ribbon/ReaderTabs';
import { removeRecent } from '@/lib/recent';
import { Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

export function WelcomeScreen() {
  const recent = useRecentFiles();
  const openImport = (importKind: ImportKind) => {
    useModalArgs.setState({ importKind });
    usePDFStore.getState().openModal('import');
  };
  return (
    <div className="flex h-full overflow-auto bg-canvas p-8" data-testid="welcome">
      <div className="m-auto w-full max-w-2xl rounded-2xl border border-app bg-panel p-10 shadow-xl">
        <AdikaLogo className="mx-auto h-16" />
        <p className="mt-4 text-center text-sm text-muted">
          Edit, sign, organise, protect and convert PDFs — entirely on this computer. Nothing is uploaded.
        </p>
        <div className="mt-8 flex justify-center">
          <Button variant="primary" size="lg" onClick={() => void openDialog()} data-testid="welcome-open">
            <FolderOpen size={18} /> Open PDF…
          </Button>
        </div>
        <p className="mt-3 text-center text-xs text-muted">or drop a PDF, image or Office file anywhere in this window</p>
        {recent.length ? (
          <div className="mt-8" data-testid="recent-files">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Clock size={12} /> Recent
            </div>
            <div className="max-h-56 overflow-auto rounded-lg border border-app">
              {recent.slice(0, 8).map((r) => (
                <div key={r.path} className="group flex items-center gap-2 border-b border-app px-3 py-2 last:border-0 hover-app">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openRecent(r)} data-testid="recent-item">
                    <div className="truncate text-[13px] font-medium">{r.name}</div>
                    <div className="truncate text-[11px] text-muted">
                      {r.path} · {r.pages} page{r.pages === 1 ? '' : 's'} · {new Date(r.openedAt).toLocaleDateString()}
                    </div>
                  </button>
                  <button type="button" aria-label={`Remove ${r.name} from recent files`} onClick={() => removeRecent(r.path)} className="hidden text-muted group-hover:block">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-8">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Tools</div>
          <QuickToolGrid compact onPick={(id) => void startQuickTool(id)} />
          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11.5px]">
            <button type="button" className="text-brand-600 hover:underline" onClick={() => openImport('html')}>
              Web page / HTML
            </button>
            <button type="button" className="text-brand-600 hover:underline" onClick={() => openImport('documents')}>
              EPUB, e-mail, XPS
            </button>
            <button type="button" className="text-brand-600 hover:underline" onClick={() => openImport('cad')}>
              CAD drawing (DXF)
            </button>
            <button type="button" className="text-brand-600 hover:underline" onClick={() => openImport('scan')}>
              Scanner / camera
            </button>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-3 gap-3 border-t border-app pt-6 text-[11.5px] text-muted">
          <Feature icon={<Signature size={15} />} text="Draw, type or upload signatures" />
          <Feature icon={<Usb size={15} />} text="PKCS#11 tokens and .p12 certificates" />
          <Feature icon={<ShieldCheck size={15} />} text="AES-256 and real redaction" />
        </div>
      </div>
    </div>
  );
}


function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-accent-600">{icon}</span>
      {text}
    </div>
  );
}
