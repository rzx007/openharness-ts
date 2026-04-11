# @openharness/skills

Skill 加载和解析系统。

## 功能

- Skill 解析 (markdown frontmatter)
- Skill 发现
- 内容加载

## 使用

```ts
import { SkillRegistry } from "@openharness/skills";

const registry = new SkillRegistry();
registry.discover(cwd);
const skill = registry.get("skill-name");
```

## 测试

```bash
pnpm --filter @openharness/skills test
```