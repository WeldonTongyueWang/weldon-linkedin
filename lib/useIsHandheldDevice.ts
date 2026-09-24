import { useEffect, useState } from 'react';

const HANDHELD_MAX_VIEWPORT_WIDTH = 820;
const PHONE_USER_AGENT_PATTERN = /android.+mobile|iphone|ipod|windows phone|blackberry|opera mini|mobile/i;
const TABLET_USER_AGENT_PATTERN = /ipad|tablet|kindle|silk|playbook/i;

const detectHandheldDevice = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  const viewportWidth = window.innerWidth;
  const userAgent = navigator.userAgent || '';
  const userAgentData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;

  if (userAgentData?.mobile) return true;
  if (PHONE_USER_AGENT_PATTERN.test(userAgent)) return true;
  if (TABLET_USER_AGENT_PATTERN.test(userAgent)) return false;

  return coarsePointer && viewportWidth <= HANDHELD_MAX_VIEWPORT_WIDTH;
};

export const useIsHandheldDevice = (): boolean => {
  const [isHandheldDevice, setIsHandheldDevice] = useState<boolean>(() => detectHandheldDevice());

  useEffect(() => {
    const updateDeviceType = () => {
      setIsHandheldDevice(detectHandheldDevice());
    };

    updateDeviceType();
    window.addEventListener('resize', updateDeviceType);

    return () => {
      window.removeEventListener('resize', updateDeviceType);
    };
  }, []);

  return isHandheldDevice;
};
