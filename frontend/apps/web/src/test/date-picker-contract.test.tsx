import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ControlLocaleProvider } from '@neocloud/ui-adapter/accessibility';
import { DatePickerField } from '@neocloud/ui-adapter/date-picker-field';

it('opens English as the first locale and keeps the configured week start', async () => {
  render(
    <ControlLocaleProvider locale="en" weekStart="monday">
      <DatePickerField label="Review date" calendarLabel="Calendar" value="2026-10-01" />
    </ControlLocaleProvider>,
  );
  await act(() => vi.dynamicImportSettled());
  expect(await screen.findByRole('spinbutton', { name: 'Year' })).toHaveAttribute(
    'aria-valuenow',
    '2026',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
  await screen.findByRole('grid');
  expect(screen.getAllByRole('columnheader')[0]).toHaveAccessibleName('Monday');
});

it('restores and clears a controlled calendar value without emitting a user edit', async () => {
  const changed = vi.fn();
  const props = { label: 'Audit date', calendarLabel: 'Calendar', onValueChange: changed };
  const view = render(<DatePickerField {...props} value="2026-10-01" />);
  await act(() => vi.dynamicImportSettled());
  const values = () =>
    screen.getAllByRole('spinbutton').map((segment) => segment.getAttribute('aria-valuenow'));
  await waitFor(() => expect(values()).toEqual(expect.arrayContaining(['2026', '10', '1'])));
  view.rerender(<DatePickerField {...props} value="2026-11-02" />);
  await waitFor(() => expect(values()).toEqual(expect.arrayContaining(['2026', '11', '2'])));
  view.rerender(<DatePickerField {...props} value={null} />);
  expect(values().every((value) => value === null)).toBe(true);
  expect(changed).not.toHaveBeenCalled();
});
