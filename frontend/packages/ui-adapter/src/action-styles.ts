type ActionStyleOptions = Readonly<{
  fullWidth?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}>;
export function actionStyles({
  fullWidth = false,
  size = 'md',
  variant = 'primary',
}: ActionStyleOptions = {}) {
  const sizes = {
    sm: 'h-control-sm gap-1.5 px-3 text-sm',
    md: 'h-control gap-2 px-4 text-sm',
    lg: 'h-control-lg gap-2.5 px-5 text-base',
  };
  const variants = {
    primary: 'border-0 bg-brand text-on-brand hover:bg-brand-strong',
    danger: 'border-0 bg-danger text-on-danger',
    secondary: 'border border-border-strong bg-transparent hover:bg-brand/8',
    quiet: 'border-0 bg-transparent hover:bg-brand/8',
  };
  return `ui-action min-h-0 inline-flex items-center justify-center rounded-action font-medium outline-none transition-colors ${sizes[size]} ${variants[variant]} ${fullWidth ? 'w-full' : ''}`;
}
