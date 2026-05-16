import { UI } from '../ui'
import { formatProvenanceLines } from '../../provenance'

export const AboutCommand = {
  command: 'about',
  describe: 'Show Nine1Bot provenance and license information',
  handler: () => {
    UI.printLogo()
    UI.title('About Nine1Bot')
    for (const line of formatProvenanceLines()) {
      UI.println(line)
    }
  },
}
