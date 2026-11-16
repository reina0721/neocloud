'use client';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { useMemo, type ReactNode } from 'react';
import type {} from '@mui/x-date-pickers/themeAugmentation';
import { designParameters } from '@clouddrive/design-system/parameters';

// MUI owns interaction anatomy; all visible roles follow the generated project tokens.
// CSS variables keep theme/accent/density changes synchronous without rebuilding the theme.
const theme = createTheme({
  typography: {
    fontFamily: 'var(--font-sans)',
    button: { textTransform: 'none', fontWeight: 600 },
  },
  shape: { borderRadius: parseFloat(designParameters.controlRadius) * 16 },
  transitions: {
    duration: {
      shortest: designParameters.duration.fast,
      shorter: designParameters.duration.fast,
      short: designParameters.duration.standard,
      standard: designParameters.duration.standard,
      complex: designParameters.duration.slow,
      enteringScreen: designParameters.duration.standard,
      leavingScreen: designParameters.duration.fast,
    },
  },
  components: {
    MuiFilledInput: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--color-surface-muted)',
          borderRadius: 'var(--radius-control)',
          minHeight: 'var(--spacing-control)',
          '&:hover,&.Mui-focused': { backgroundColor: 'var(--color-surface-muted)' },
          '&::before': { borderBottomColor: 'var(--color-border)' },
          '&::after': { borderBottomColor: 'var(--color-brand)' },
        },
        input: { padding: '0.625rem 0.875rem' },
      },
    },

    MuiPickerDay: {
      styleOverrides: {
        root: {
          color: 'var(--color-ink)',
          '&.Mui-selected,&.Mui-selected:hover,&.Mui-selected:focus': {
            backgroundColor: 'var(--color-brand)',
            color: 'var(--color-on-brand)',
          },
          '&:hover,&:focus': { backgroundColor: 'var(--color-brand-soft)' },
        },
      },
    },
    MuiPickersOutlinedInput: {
      styleOverrides: {
        root: {
          color: 'var(--color-ink)',
          borderRadius: 'var(--radius-control)',
          '&:hover .MuiPickersOutlinedInput-notchedOutline': {
            borderColor: 'var(--color-border-strong)',
          },
          '&.Mui-error .MuiPickersOutlinedInput-notchedOutline': {
            borderColor: 'var(--color-danger)',
          },
          '&.Mui-disabled': {
            color: 'var(--color-ink-muted)',
            opacity: 0.55,
            '& .MuiPickersOutlinedInput-notchedOutline': {
              borderColor: 'var(--color-border-strong)',
            },
          },
          '&.Mui-focused:not(.Mui-error) .MuiPickersOutlinedInput-notchedOutline': {
            borderColor: 'var(--color-brand)',
          },
        },
        notchedOutline: { borderColor: 'var(--color-border-strong)' },
      },
    },

    MuiButtonBase: {
      styleOverrides: {
        root: {
          fontFamily: 'var(--font-sans)',
          '&.Mui-focusVisible': {
            outline: 'var(--spacing-focus-ring-width) solid var(--color-focus-ring)',
            outlineOffset: 'var(--spacing-focus-ring-offset)',
          },
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true, disableFocusRipple: true },
      styleOverrides: {
        root: ({ ownerState }) => ({
          borderRadius: 'var(--radius-action)',
          minHeight: 'var(--spacing-control)',
          color:
            ownerState.variant === 'contained' ? 'var(--color-on-brand)' : 'var(--color-brand)',
          ...(ownerState.variant === 'contained'
            ? {
                backgroundColor:
                  ownerState.color === 'error' ? 'var(--color-danger)' : 'var(--color-brand)',
                color:
                  ownerState.color === 'error' ? 'var(--color-on-danger)' : 'var(--color-on-brand)',
              }
            : {}),
          ...(ownerState.variant === 'outlined'
            ? { borderColor: 'var(--color-border-strong)' }
            : {}),
          '&:hover': {
            backgroundColor:
              ownerState.variant === 'contained'
                ? ownerState.color === 'error'
                  ? 'color-mix(in srgb, var(--color-danger) 88%, var(--color-ink))'
                  : 'var(--color-brand-strong)'
                : ownerState.color === 'error'
                  ? 'var(--color-danger-soft)'
                  : 'var(--color-brand-soft)',
          },
          '&.Mui-disabled': {
            opacity: 0.5,
            color: 'var(--color-ink-muted)',
            backgroundColor: 'var(--color-surface-inset)',
          },
        }),
      },
    },
    MuiIconButton: {
      defaultProps: { disableFocusRipple: true },
      styleOverrides: {
        root: {
          color: 'var(--color-ink-muted)',
          '&:hover': { backgroundColor: 'var(--color-brand-soft)', color: 'var(--color-brand)' },
          '&.Mui-disabled': { color: 'var(--color-ink-muted)', opacity: 0.5 },
        },
      },
    },
    MuiInputBase: {
      styleOverrides: {
        root: { color: 'var(--color-ink)', fontFamily: 'var(--font-sans)', fontSize: '0.875rem' },
        input: {
          '&::placeholder': { color: 'var(--color-ink-muted)', opacity: 0.75 },
          '&.Mui-disabled': { WebkitTextFillColor: 'var(--color-ink-muted)' },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          minHeight: 'var(--spacing-control)',
          borderRadius: 'var(--radius-control)',
          backgroundColor: 'var(--color-surface)',
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--color-border-strong)' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--color-brand)' },
          '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--color-danger)' },
        },
        input: { padding: '0.625rem 0.875rem' },
        notchedOutline: { borderColor: 'var(--color-border-strong)' },
      },
    },
    MuiSelect: {
      styleOverrides: {
        icon: { color: 'var(--color-ink-muted)' },
        select: { '&&': { paddingInlineEnd: 'calc(var(--spacing-icon-lg) + var(--spacing) * 3)' } },
      },
    },
    MuiFormHelperText: {
      styleOverrides: {
        root: {
          marginInline: 0,
          color: 'var(--color-ink-muted)',
          '&.Mui-error': { color: 'var(--color-danger)' },
        },
      },
    },
    MuiFormLabel: {
      styleOverrides: {
        root: { color: 'var(--color-ink-muted)', '&.Mui-focused': { color: 'var(--color-brand)' } },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--color-surface-raised)',
          backgroundImage: 'none',
          color: 'var(--color-ink)',
        },
      },
    },
    MuiBackdrop: {
      styleOverrides: {
        root: ({ ownerState }) => ({
          backgroundColor: ownerState.invisible ? 'transparent' : 'var(--color-scrim)',
        }),
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: '0.875rem',
          minHeight: 'var(--spacing-option)',
          color: 'var(--color-ink)',
          whiteSpace: 'normal',
          '&:hover,&.Mui-focusVisible': { backgroundColor: 'var(--color-surface-muted)' },
          '&.Mui-selected,&.Mui-selected:hover': {
            color: 'var(--color-brand)',
            backgroundColor: 'var(--color-brand-soft)',
          },
        },
      },
    },
    MuiListSubheader: {
      styleOverrides: {
        root: { backgroundColor: 'var(--color-surface)', color: 'var(--color-ink-muted)' },
      },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: 'var(--color-border)' } } },
    MuiAutocomplete: {
      styleOverrides: {
        popupIndicator: { color: 'var(--color-ink-muted)' },
        clearIndicator: { color: 'var(--color-ink-muted)' },
        option: {
          color: 'var(--color-ink)',
          '&[aria-selected="true"],&[aria-selected="true"].Mui-focused': {
            backgroundColor: 'var(--color-brand-soft)',
            color: 'var(--color-brand)',
          },
          '&.Mui-focused,&.Mui-focusVisible': { backgroundColor: 'var(--color-surface-muted)' },
        },
        noOptions: { color: 'var(--color-ink-muted)' },
        loading: { color: 'var(--color-ink-muted)' },
      },
    },
    MuiPaginationItem: {
      styleOverrides: {
        root: {
          color: 'var(--color-ink)',
          borderColor: 'var(--color-border)',
          '&:hover': { backgroundColor: 'var(--color-surface-muted)' },
          '&.Mui-selected,&.Mui-selected:hover': {
            backgroundColor: 'var(--color-brand-soft)',
            color: 'var(--color-brand)',
          },
        },
      },
    },
    MuiTableSortLabel: {
      styleOverrides: {
        root: {
          color: 'var(--color-ink-muted)',
          '&.Mui-active,&:hover': { color: 'var(--color-brand)' },
        },
        icon: { color: 'inherit' },
      },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: {
          color: 'var(--color-border-strong)',
          padding: '0.375rem',
          '&.Mui-checked,&.MuiCheckbox-indeterminate': { color: 'var(--color-brand)' },
          '&.Mui-disabled': { color: 'var(--color-border-strong)', opacity: 0.5 },
        },
      },
    },
    MuiRadio: {
      styleOverrides: {
        root: {
          color: 'var(--color-border-strong)',
          '&.Mui-checked': { color: 'var(--color-brand)' },
          '&.Mui-disabled': { color: 'var(--color-border-strong)' },
          '&.Mui-focusVisible': { outline: 'none' },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        root: {
          width: 'var(--spacing-switch-width)',
          height: 'var(--spacing-switch-height)',
          padding: 0,
          overflow: 'visible',
          flexShrink: 0,
        },
        switchBase: {
          padding: 'var(--spacing-switch-inset)',
          color: 'var(--color-ink-muted)',
          '&.Mui-checked': {
            transform:
              'translateX(calc(var(--spacing-switch-width) - var(--spacing-switch-height)))',
            color: 'var(--color-on-brand)',
            '& + .MuiSwitch-track': { backgroundColor: 'var(--color-brand)', opacity: 1 },
          },
          '&.Mui-disabled': { color: 'var(--color-ink-muted)', opacity: 0.5 },
          '&.Mui-disabled + .MuiSwitch-track': { opacity: 0.4 },
        },
        track: {
          borderRadius: 'var(--radius-action)',
          backgroundColor: 'var(--color-surface-inset)',
          border: '1px solid var(--color-border-strong)',
          opacity: 1,
        },
        thumb: {
          width: 'var(--spacing-switch-thumb)',
          height: 'var(--spacing-switch-thumb)',
          boxShadow: 'var(--shadow-panel)',
        },
      },
    },
    MuiSlider: {
      styleOverrides: {
        root: { color: 'var(--color-brand)' },
        rail: { backgroundColor: 'var(--color-border-strong)' },
        thumb: {
          '&:hover,&.Mui-active': {
            boxShadow: '0 0 0 0.375rem color-mix(in srgb, var(--color-brand) 20%, transparent)',
          },
          '&.Mui-focusVisible': {
            boxShadow: '0 0 0 var(--spacing-focus-ring-width) var(--color-focus-ring)',
          },
        },
      },
    },
    MuiCircularProgress: {
      styleOverrides: {
        root: ({ ownerState }) => ({
          color: ownerState.color === 'inherit' ? 'inherit' : 'var(--color-brand)',
        }),
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { backgroundColor: 'var(--color-surface-inset)' },
        bar: { backgroundColor: 'var(--color-brand)' },
      },
    },
    MuiSkeleton: {
      styleOverrides: {
        root: { backgroundColor: 'var(--color-surface-inset)', transform: 'none' },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: 'var(--color-ink)',
          color: 'var(--color-surface)',
          fontFamily: 'var(--font-sans)',
          fontSize: '0.75rem',
          borderRadius: 'var(--radius-control)',
          padding: '0.5rem 0.75rem',
        },
        arrow: { color: 'var(--color-ink)' },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 'var(--radius-shell)',
          boxShadow: 'var(--shadow-overlay)',
          border: '1px solid var(--color-border)',
          maxHeight: 'calc(100dvh - 2rem)',
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 'var(--spacing-control)' },
        indicator: { backgroundColor: 'var(--color-brand)', borderRadius: 'var(--radius-action)' },
      },
    },
    MuiTab: {
      defaultProps: { disableFocusRipple: true },
      styleOverrides: {
        root: {
          minHeight: 'var(--spacing-control)',
          minWidth: 0,
          textTransform: 'none',
          fontSize: '0.875rem',
          color: 'var(--color-ink-muted)',
          '&.Mui-selected': { color: 'var(--color-brand)' },
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          color: 'var(--color-ink-muted)',
          borderColor: 'var(--color-border)',
          textTransform: 'none',
          '&.Mui-selected,&.Mui-selected:hover': {
            color: 'var(--color-brand)',
            backgroundColor: 'var(--color-brand-soft)',
          },
        },
      },
    },
    MuiAccordion: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--color-surface)',
          color: 'var(--color-ink)',
          boxShadow: 'none',
          border: '1px solid var(--color-border)',
          '&::before': { display: 'none' },
        },
      },
    },
    MuiAvatar: {
      styleOverrides: {
        root: {
          backgroundColor: 'var(--color-surface-inset)',
          color: 'var(--color-ink)',
          fontFamily: 'var(--font-sans)',
        },
      },
    },
  },
});

export function MaterialThemeProvider({
  children,
  reducedMotion = false,
  highContrast = false,
  motionScale = 1,
}: Readonly<{
  children: ReactNode;
  reducedMotion?: boolean;
  highContrast?: boolean;
  motionScale?: 1 | 2 | 4;
}>) {
  const effectiveTheme = useMemo(() => {
    const scale = reducedMotion ? 0 : motionScale;
    const overlayDuration = highContrast ? 0 : designParameters.duration.standard * scale;
    return createTheme(theme, {
      transitions: {
        duration: Object.fromEntries(
          Object.entries(theme.transitions.duration).map(([key, value]) => [key, value * scale]),
        ),
      },
      components: {
        MuiButtonBase: { defaultProps: { disableRipple: reducedMotion } },
        MuiDialog: { defaultProps: { transitionDuration: overlayDuration } },
        MuiMenu: { defaultProps: { transitionDuration: overlayDuration } },
        MuiPopover: { defaultProps: { transitionDuration: overlayDuration } },
        MuiDrawer: { defaultProps: { transitionDuration: overlayDuration } },
        MuiTooltip: { defaultProps: { slotProps: { transition: { timeout: overlayDuration } } } },
      },
    });
  }, [reducedMotion, highContrast, motionScale]);
  return <ThemeProvider theme={effectiveTheme}>{children}</ThemeProvider>;
}
