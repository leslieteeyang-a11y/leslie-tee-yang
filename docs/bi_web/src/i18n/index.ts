import core from './core';
import purchasing from './purchasing';
import manager from './manager';
import finance from './finance';
import ecom from './ecom';
import pages1 from './pages1';
import pages2 from './pages2';
import loyalty from './loyalty';
import health from './health';

// 各分页各自一个字典档,避免多人同时改同一档冲突;这里合并
export const DICT: Record<string, string> = { ...loyalty, ...core, ...purchasing, ...manager, ...finance, ...ecom, ...pages1, ...pages2, ...health };
