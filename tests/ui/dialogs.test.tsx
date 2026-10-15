import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button, Checkbox, Dialog, Field, Input, Select, TooltipProvider } from '@/components/ui/primitives';
import { Modals } from '@/components/modals/Modals';
import { askConfirm, askPassword, useDialogs } from '@/store/useDialogs';

function Harness({ onOpenChange }: { onOpenChange?: (o: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">Outside</button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          onOpenChange?.(o);
          setOpen(o);
        }}
        title="Document properties"
        description="Title and author of the file."
        footer={<Button>Apply</Button>}
      >
        <Field label="Title">
          <Input data-autofocus defaultValue="" />
        </Field>
        <Field label="Page size">
          <Select value="a4" onChange={() => {}} options={[{ value: 'a4', label: 'A4' }]} />
        </Field>
        <Field label="Margins">
          <Input aria-label="Top" />
          <Input aria-label="Bottom" />
        </Field>
      </Dialog>
    </>
  );
}

describe('Dialog primitive', () => {
  it('is a modal dialog named by its title and described by its description', () => {
    render(<Harness />);
    const dlg = screen.getByRole('dialog', { name: 'Document properties' });
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(dlg.getAttribute('aria-describedby')!)?.textContent).toBe('Title and author of the file.');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('focuses the [data-autofocus] control and keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dlg = screen.getByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Title')));
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await user.tab({ shift: true });
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it('Esc closes it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Field', () => {
  it('ties its label to a single control (input or select)', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Title').tagName).toBe('INPUT');
    expect(screen.getByLabelText('Page size').tagName).toBe('SELECT');
  });

  it('names a group when it holds several controls, keeping each control’s own name', () => {
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Margins' });
    expect(group.querySelectorAll('input')).toHaveLength(2);
    expect(screen.getByRole('textbox', { name: 'Top' })).toBeTruthy();
  });

  it('keeps an id the control already has', () => {
    render(
      <Field label="Author">
        <Input id="author-input" />
      </Field>,
    );
    expect(screen.getByLabelText('Author').id).toBe('author-input');
  });

  it('a checkbox is named by its label text', () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Embed fonts" />);
    expect(screen.getByRole('checkbox', { name: 'Embed fonts' })).toBeTruthy();
  });
});

describe('prompt queue (rendered)', () => {
  it('two confirms are shown one after the other, each answer going to its caller', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Modals />
      </TooltipProvider>,
    );
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = askConfirm({ title: 'Delete page 2?', message: 'The page is removed.', confirmLabel: 'Delete', danger: true });
      second = askConfirm({ title: 'Replace the file?', message: 'It exists.' });
    });
    expect(screen.getByRole('dialog', { name: 'Delete page 2?' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Replace the file?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await first).toBe(true);
    await screen.findByRole('dialog', { name: 'Replace the file?' });
    await user.keyboard('{Escape}');
    expect(await second).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useDialogs.getState().confirm).toBeNull();
  });

  it('the password prompt submits with Enter and clears the field for the next file', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <Modals />
      </TooltipProvider>,
    );
    let a!: Promise<string | null>;
    let b!: Promise<string | null>;
    act(() => {
      a = askPassword('a.pdf', false);
      b = askPassword('b.pdf', true);
    });
    const input = await screen.findByLabelText('Password');
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.type(input, 'secret{Enter}');
    expect(await a).toBe('secret');
    await screen.findByText('“b.pdf” is protected.');
    expect(screen.getByText('Incorrect password. Try again.')).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await b).toBeNull();
  });
});
