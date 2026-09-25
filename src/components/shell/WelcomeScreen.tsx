import { FileImage, FileType2, FolderOpen, Globe, ScanLine, ShieldCheck, Signature, Usb } from 'lucide-react';
import { openDialog } from '@/actions/document';
import { usePDFStore } from '@/store/usePDFStore';
import { useModalArgs, type ImportKind } from '@/store/useModalArgs';
import { AdikaLogo } from './AdikaLogo';
import { Button } from '@/components/ui/primitives';

export function WelcomeScreen() {
  const openImport = (importKind: ImportKind) => {
    useModalArgs.setState({ importKind });
    usePDFStore.getState().openModal('import');
  };
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-canvas p-8" data-testid="welcome">
      <div className="w-full max-w-2xl rounded-2xl border border-app bg-panel p-10 shadow-xl">
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
        <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile icon={<FileType2 size={18} />} label="Word / Excel / PowerPoint" onClick={() => openImport('office')} />
          <Tile icon={<FileImage size={18} />} label="Images to PDF" onClick={() => openImport('images')} />
          <Tile icon={<Globe size={18} />} label="Web page / HTML" onClick={() => openImport('html')} />
          <Tile icon={<ScanLine size={18} />} label="Scan / camera" onClick={() => openImport('scan')} />
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

function Tile({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-2 rounded-lg border border-app px-2 py-3 text-center text-[11.5px] hover-app">
      <span className="text-brand-600 dark:text-brand-400">{icon}</span>
      {label}
    </button>
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
