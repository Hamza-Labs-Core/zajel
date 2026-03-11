/**
 * Summary metric card component.
 */
import type { ComponentChildren } from 'preact';

interface CardProps {
  title: string;
  value: string | number;
  valueColor?: string;
  children?: ComponentChildren;
}

export function Card({ title, value, valueColor }: CardProps) {
  return (
    <div class="stat-card">
      <div class="stat-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      <div class="stat-title">{title}</div>
    </div>
  );
}

interface CardGridProps {
  children: ComponentChildren;
}

export function CardGrid({ children }: CardGridProps) {
  return <div class="card-grid">{children}</div>;
}
