import * as SeparatorPrimitive from '@radix-ui/react-separator'
import type { ComponentProps } from 'react'
import { cn } from '@renderer/lib/utils'

export function Separator({ className, orientation = 'horizontal', ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn(orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', 'bg-white/10', className)}
      {...props}
    />
  )
}
