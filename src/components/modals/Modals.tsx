import { useState } from 'react';
import { useDialogs } from '@/store/useDialogs';
import { Button, Callout, Dialog, Field, Input } from '@/components/ui/primitives';
import { SignatureModal } from './SignatureModal';
import { CertificateModal, StoreCertModal, TokenModal, VerifyModal } from './DigitalSignModals';
import { AboutModal, CompressModal, OcrModal, OrganizerModal, PasswordModal, PdfaModal, SplitModal } from './DocumentModals';
import { ExportModal, ImportModal } from './ConvertModals';
import { PropertiesModal } from './PropertiesModal';
import { ToolsModal } from './ToolsModal';
import { CropModal, LinkModal, PageMarksModal } from './PageToolModals';
import { FindRedactModal } from './FindRedactModal';
import { BatchModal } from './BatchModal';
import { MailMergeModal } from './MailMergeModal';
import { AccessibilityModal } from './AccessibilityModal';
import { ReadingView } from '@/components/viewer/ReadingView';
import { ScanModal } from './ScanModal';
import { PrintProductionModal } from './PrintProductionModal';
import { SpellCheckModal } from './SpellCheckModal';
import { EInvoiceModal, PortfolioModal } from './EInvoiceModals';
import { PageSizeModal } from './PageToolModals';
import { CustomizeModal } from '@/components/shell/CustomizeModal';
import { FolderSearchModal } from './FolderSearchModal';
import { CertEncryptModal, CertKeyDialog } from './CertEncryptModals';
import { RecoverModal } from './RecoverModal';
import { PrintModal } from './PrintModal';
import { ReplacePagesModal } from './ReplacePagesModal';
import { HiddenInfoModal } from './HiddenInfoModal';

export function Modals() {
  return (
    <>
      <SignatureModal />
      <CertificateModal />
      <TokenModal />
      <StoreCertModal />
      <VerifyModal />
      <OrganizerModal />
      <SplitModal />
      <PasswordModal />
      <CompressModal />
      <OcrModal />
      <PdfaModal />
      <ExportModal />
      <ImportModal />
      <AboutModal />
      <PropertiesModal />
      <ToolsModal />
      <LinkModal />
      <CropModal />
      <PageMarksModal />
      <FindRedactModal />
      <BatchModal />
      <MailMergeModal />
      <AccessibilityModal />
      <ReadingView />
      <ScanModal />
      <PrintProductionModal />
      <SpellCheckModal />
      <EInvoiceModal />
      <PortfolioModal />
      <PageSizeModal />
      <CustomizeModal />
      <FolderSearchModal />
      <CertEncryptModal />
      <CertKeyDialog />
      <RecoverModal />
      <PrintModal />
      <ReplacePagesModal />
      <HiddenInfoModal />
      <PasswordPrompt />
      <ConfirmPrompt />
    </>
  );
}

function PasswordPrompt() {
  const prompt = useDialogs((s) => s.password);
  const [value, setValue] = useState('');
  if (!prompt) return null;
  const submit = () => {
    const v = value;
    setValue('');
    prompt.resolve(v);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setValue('');
          prompt.resolve(null);
        }
      }}
      title="Password required"
      description={`“${prompt.fileName}” is protected.`}
      width={420}
      testId="password-prompt"
      footer={
        <>
          <Button
            onClick={() => {
              setValue('');
              prompt.resolve(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} data-testid="password-submit">
            Open
          </Button>
        </>
      }
    >
      {prompt.incorrect ? <Callout kind="error">Incorrect password. Try again.</Callout> : null}
      <Field label="Password">
        <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} data-autofocus data-testid="password-input" />
      </Field>
    </Dialog>
  );
}

function ConfirmPrompt() {
  const c = useDialogs((s) => s.confirm);
  if (!c) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && c.resolve(false)}
      title={c.title}
      width={440}
      testId="confirm-prompt"
      footer={
        <>
          {c.messageOnly ? null : <Button onClick={() => c.resolve(false)}>Cancel</Button>}
          {c.altLabel ? (
            <Button onClick={() => c.resolve('alt')} data-testid="confirm-alt">
              {c.altLabel}
            </Button>
          ) : null}
          <Button variant={c.danger ? 'danger' : 'primary'} onClick={() => c.resolve(true)} data-testid="confirm-ok">
            {c.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-[13px] leading-relaxed" data-no-translate={c.messageOnly || undefined}>
        {c.message}
      </p>
    </Dialog>
  );
}
