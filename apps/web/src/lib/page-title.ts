import { useEffect } from 'react'
import { PRODUCT_NAME } from './product.ts'

/** Sets the document title ("Sign in · ChatApp"); every page has its own, which screen readers announce on navigation. */
export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${PRODUCT_NAME}` : PRODUCT_NAME
  }, [title])
}
